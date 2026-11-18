import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type GuildMember,
} from 'discord.js';
import { APPLICATION_STATUS, COLORS, QUESTION_TYPES, type ApplicationStatus } from '../../config/constants';
import { getGuild } from '../../bot/client';
import { brandEmbed, embedLength, safeField } from '../../bot/ui/embeds';
import { deleteMessage, fetchMessage, upsertMessage } from '../../bot/messages';
import { cid } from '../../bot/types';
import { explainDiscordError } from '../../bot/reply';
import { debounce, withLock } from '../../core/guards';
import { discordTs, formatDuration } from '../../core/time';
import { sanitizeMentions, truncate } from '../../core/text';
import { childLogger } from '../../core/logger';
import { getSetting } from '../../core/settings';
import { audit } from '../logs/audit';
import { applications, answersOf, choicesOf, drafts, forms, questions, type Application, type Form, type Question } from './forms.repo';
import { FORM_STATE_LABEL, LIMITS, answerText, formState, pages, snapshotAnswers, validateAnswers } from './forms.logic';

const log = childLogger('whitelist');

// ───────────── Message public du formulaire ─────────────

export function formPublicPayload(f: Form) {
  const count = applications.countForForm(f.id);
  const state = formState(f, count);
  const e = brandEmbed({ title: f.title, description: f.description || undefined, color: state === 'open' ? undefined : COLORS.muted, timestamp: false });
  if (f.banner_url) e.setImage(f.banner_url);
  e.addFields({ name: 'Statut', value: FORM_STATE_LABEL[state], inline: true });
  if (f.opens_at && state === 'scheduled') e.addFields({ name: 'Ouverture', value: `${discordTs(f.opens_at, 'F')} (${discordTs(f.opens_at, 'R')})`, inline: true });
  if (f.closes_at && (state === 'open' || state === 'scheduled')) e.addFields({ name: 'Clôture', value: `${discordTs(f.closes_at, 'F')} (${discordTs(f.closes_at, 'R')})`, inline: true });
  if (f.max_applications && state !== 'closed') e.addFields({ name: 'Places', value: `${Math.max(0, f.max_applications - count)} / ${f.max_applications} restantes`, inline: true });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('wla', 'start', f.id))
      .setLabel(truncate(f.button_label || 'Postuler', 80))
      .setEmoji('📝')
      .setStyle(state === 'open' ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(state !== 'open'),
  );
  return { embeds: [e], components: [row], state };
}

/** Publie ou met à jour le message du formulaire. */
export async function publishForm(formId: number): Promise<{ channelId: string; messageId: string }> {
  const f = forms.get(formId);
  if (!f) throw new Error('Formulaire introuvable');
  if (!f.publish_channel_id) throw new Error('Aucun salon de publication n’est défini (bouton « Salons & rôles »).');
  if (!questions.count(f.id)) throw new Error('Ajoute au moins une question avant de publier.');
  if (f.status === 'draft') forms.update(f.id, { status: 'open' });
  const fresh = forms.get(f.id)!;
  const { state, ...payload } = formPublicPayload(fresh);
  const previousChannel = fresh.message_id ? (fresh.published_state?.split('|')[1] ?? fresh.publish_channel_id) : null;
  const loc = await upsertMessage(fresh.publish_channel_id!, { channelId: previousChannel, messageId: fresh.message_id }, payload);
  forms.update(f.id, { message_id: loc.messageId, published_state: `${state}|${loc.channelId}` });
  return loc;
}

/** Rafraîchit le message public (regroupé si plusieurs changements rapprochés). */
export function scheduleFormRefresh(formId: number): void {
  debounce(`form:${formId}`, 1500, async () => {
    const f = forms.get(formId);
    if (!f?.message_id || !f.publish_channel_id || !questions.count(formId)) return;
    await publishForm(formId);
  }, (e) => log.warn({ err: e, formId }, 'Mise à jour du formulaire impossible'));
}

/** Tâche planifiée : met à jour les formulaires dont l'état a changé (ouverture/fermeture par date, complet). */
export function refreshFormStates(): void {
  for (const f of forms.list()) {
    if (!f.message_id) continue;
    const state = formState(f, applications.countForForm(f.id));
    if (f.published_state?.split('|')[0] !== state) scheduleFormRefresh(f.id);
  }
}

export async function unpublishForm(f: Form): Promise<void> {
  if (f.message_id) await deleteMessage(f.published_state?.split('|')[1] ?? f.publish_channel_id, f.message_id);
  forms.update(f.id, { message_id: null, published_state: null });
}

// ───────────── Candidature : fenêtres modales par étape ─────────────

/** Contrôles avant de laisser un membre postuler. Retourne un message d'erreur ou null. */
export function canApply(f: Form, member: GuildMember): string | null {
  const state = formState(f, applications.countForForm(f.id));
  if (state === 'scheduled') return `Les candidatures ouvriront ${discordTs(f.opens_at!, 'R')}.`;
  if (state === 'ended') return 'Les candidatures sont terminées.';
  if (state === 'full') return 'Le nombre maximal de candidatures est atteint.';
  if (state !== 'open') return 'Ce formulaire n’accepte pas de candidatures pour le moment.';
  if (applications.active(f.id, member.id)) return 'Tu as déjà une candidature en cours d’examen pour ce formulaire.';
  const last = applications.lastForUser(f.id, member.id);
  if (last?.status === 'accepted') return 'Ta candidature a déjà été acceptée 🎉';
  if (last?.status === 'refused' && f.reapply_days > 0) {
    const until = (last.decided_at ?? last.created_at) + f.reapply_days * 864e5;
    if (until > Date.now()) return `Tu pourras postuler à nouveau ${discordTs(until, 'R')}.`;
  }
  if (f.accepted_role_id && member.roles.cache.has(f.accepted_role_id)) return 'Tu as déjà le rôle attribué par ce formulaire.';
  return null;
}

export function buildPageModal(f: Form, qs: Question[], pageIndex: number, totalPages: number, prefill: Record<string, string | string[]>): ModalBuilder {
  const suffix = totalPages > 1 ? ` (${pageIndex + 1}/${totalPages})` : '';
  const modal = new ModalBuilder().setCustomId(cid('wla', 'page', f.id, pageIndex)).setTitle(truncate(f.title, 45 - suffix.length) + suffix);
  for (const q of qs) {
    const label = new LabelBuilder().setLabel(truncate(q.label, LIMITS.label));
    if (q.description) label.setDescription(truncate(q.description, LIMITS.description));
    const id = `q${q.id}`;
    const value = prefill[String(q.id)];
    if (q.type === 'single' || q.type === 'multi') {
      const choices = choicesOf(q);
      const selected = new Set(Array.isArray(value) ? value : value ? [value] : []);
      const select = new StringSelectMenuBuilder()
        .setCustomId(id)
        .setRequired(!!q.required)
        .setMinValues(q.required ? 1 : 0)
        .setMaxValues(q.type === 'single' ? 1 : choices.length)
        .addOptions(choices.map((c, idx) => ({ label: truncate(c, 100), value: String(idx), default: selected.has(String(idx)) })));
      if (q.placeholder) select.setPlaceholder(truncate(q.placeholder, 150));
      label.setStringSelectMenuComponent(select);
    } else {
      const max = q.type === 'long' ? LIMITS.long : q.type === 'number' ? LIMITS.number : q.type === 'roblox' ? LIMITS.roblox : LIMITS.short;
      const input = new TextInputBuilder()
        .setCustomId(id)
        .setStyle(q.type === 'long' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(!!q.required)
        .setMaxLength(max);
      if (q.type === 'roblox') input.setMinLength(3);
      const ph = q.placeholder ?? (q.type === 'number' ? `Nombre${q.min_value !== null || q.max_value !== null ? ` (${q.min_value ?? '…'} à ${q.max_value ?? '…'})` : ''}` : null);
      if (ph) input.setPlaceholder(truncate(ph, 100));
      if (typeof value === 'string' && value.trim()) input.setValue(truncate(value, max));
      label.setTextInputComponent(input);
    }
    modal.addLabelComponents(label);
  }
  return modal;
}

/** Lit les valeurs brutes d'une étape depuis la soumission de la modale. */
export function readPageValues(fields: { getTextInputValue(id: string): string; getStringSelectValues(id: string): readonly string[] }, qs: Question[]) {
  const out: Record<string, string | string[]> = {};
  for (const q of qs) {
    const id = `q${q.id}`;
    try {
      out[String(q.id)] = q.type === 'single' || q.type === 'multi' ? [...fields.getStringSelectValues(id)] : fields.getTextInputValue(id) ?? '';
    } catch {
      out[String(q.id)] = q.type === 'single' || q.type === 'multi' ? [] : '';
    }
  }
  return out;
}

export interface PageResult {
  status: 'error' | 'next' | 'done';
  errors?: string[];
  nextPage?: number;
  totalPages?: number;
  applicationId?: number;
}

/** Enregistre une étape ; à la dernière, crée la candidature. */
export async function submitPage(f: Form, member: GuildMember, pageIndex: number, values: Record<string, string | string[]>): Promise<PageResult> {
  const all = questions.list(f.id);
  const pgs = pages(all);
  const page = pgs[pageIndex];
  if (!page) return { status: 'error', errors: ['Le formulaire a été modifié entre-temps : recommence ta candidature.'] };
  const draft = { ...drafts.get(member.id, f.id), ...values };
  drafts.save(member.id, f.id, draft);
  const errors = validateAnswers(page, values);
  if (errors.length) return { status: 'error', errors };
  if (pageIndex + 1 < pgs.length) return { status: 'next', nextPage: pageIndex + 1, totalPages: pgs.length };

  return withLock(`apply:${f.id}:${member.id}`, async () => {
    const fresh = forms.get(f.id);
    if (!fresh) return { status: 'error' as const, errors: ['Ce formulaire n’existe plus.'] };
    const blocked = canApply(fresh, member);
    if (blocked) return { status: 'error' as const, errors: [blocked] };
    const allErrors = validateAnswers(all, draft);
    if (allErrors.length) return { status: 'error' as const, errors: allErrors };
    const answers = snapshotAnswers(all, draft);
    const robloxAnswer = answers.find((a) => a.type === 'roblox' && typeof a.value === 'string' && a.value);
    const roblox = (robloxAnswer?.value as string | undefined) ?? null;
    const robloxId = roblox ? await lookupRobloxId(roblox) : null;
    let appId: number;
    try {
      appId = applications.create({ formId: f.id, userId: member.id, userTag: member.user.tag, answers, roblox, robloxId });
    } catch (e) {
      if (String((e as Error).message).includes('UNIQUE')) return { status: 'error' as const, errors: ['Tu as déjà une candidature en cours pour ce formulaire.'] };
      throw e;
    }
    drafts.clear(member.id, f.id);
    applications.addEvent(appId, member.id, 'submitted');
    await postReviewMessage(appId).catch((e) => log.error({ err: e }, 'Publication de la candidature au staff impossible'));
    await audit({ type: 'applications', action: 'submit', actorId: member.id, target: `Candidature n°${appId}`, message: `Nouvelle candidature n°${appId} pour « ${fresh.title} ».`, color: COLORS.info });
    scheduleFormRefresh(f.id);
    return { status: 'done' as const, applicationId: appId };
  });
}

/** Résout l'identifiant Roblox (facultatif, sans bloquer si l'API Roblox ne répond pas). */
export async function lookupRobloxId(username: string): Promise<string | null> {
  try {
    const res = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { id: number }[] };
    return json.data?.[0]?.id ? String(json.data[0].id) : null;
  } catch {
    return null;
  }
}

// ───────────── Examen par le staff ─────────────

export function reviewEmbed(a: Application, member: GuildMember | null, full = false) {
  const f = forms.get(a.form_id);
  const st = APPLICATION_STATUS[a.status];
  const e = brandEmbed({ title: `📋 Candidature n°${a.id} — ${f?.title ?? 'Formulaire supprimé'}`, color: st.color, footerExtra: `ID candidature ${a.id}` });
  e.setAuthor({ name: member?.user.tag ?? a.user_tag ?? a.user_id, iconURL: member?.displayAvatarURL() });
  if (member) e.setThumbnail(member.displayAvatarURL({ size: 128 }));
  e.addFields(
    { name: 'Membre', value: `<@${a.user_id}>\n\`${a.user_id}\``, inline: true },
    { name: 'Pseudo Roblox', value: a.roblox_username ? (a.roblox_id ? `[${a.roblox_username}](https://www.roblox.com/users/${a.roblox_id}/profile)` : a.roblox_username) : '—', inline: true },
    { name: 'Statut', value: `${st.emoji} ${st.label}`, inline: true },
    { name: 'Soumise le', value: discordTs(a.created_at, 'f'), inline: true },
  );
  if (member) e.addFields({ name: 'Compte créé', value: discordTs(member.user.createdTimestamp, 'R'), inline: true }, { name: 'Sur le serveur depuis', value: member.joinedTimestamp ? discordTs(member.joinedTimestamp, 'R') : '—', inline: true });
  const answers = answersOf(a);
  const limit = full ? 1024 : 400;
  answers.forEach((ans, idx) => safeField(e, `${idx + 1}. ${QUESTION_TYPES[ans.type]?.emoji ?? ''} ${ans.label}`, sanitizeMentions(truncate(answerText(ans), limit))));
  if (a.decided_by && a.status !== 'pending') {
    safeField(e, 'Décision', `${st.emoji} par <@${a.decided_by}> ${a.decided_at ? discordTs(a.decided_at, 'R') : ''}${a.decision_reason ? `\nMotif : ${a.decision_reason}` : ''}`);
  }
  const notes = applications.notes(a.id).length;
  if (notes) safeField(e, 'Notes internes', `${notes} note(s) — bouton « Consulter »`, true);
  // Sécurité : Discord refuse un message de plus de 6000 caractères.
  while (embedLength(e) > 5800 && (e.data.fields?.length ?? 0) > 6) e.spliceFields(-1, 1);
  return e;
}

export function reviewButtons(a: Application) {
  const decided = a.status === 'accepted' || a.status === 'refused';
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(cid('wlr', 'accept', a.id)).setLabel('Accepter').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(decided),
      new ButtonBuilder().setCustomId(cid('wlr', 'refuse', a.id)).setLabel('Refuser').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(decided),
      new ButtonBuilder().setCustomId(cid('wlr', 'hold', a.id)).setLabel('En attente').setEmoji('⏸️').setStyle(ButtonStyle.Secondary).setDisabled(decided || a.status === 'on_hold'),
      new ButtonBuilder().setCustomId(cid('wlr', 'note', a.id)).setLabel('Note').setEmoji('📝').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(cid('wlr', 'view', a.id)).setLabel('Consulter').setEmoji('🔎').setStyle(ButtonStyle.Primary),
    ),
  ];
}

export async function postReviewMessage(appId: number): Promise<void> {
  const a = applications.get(appId);
  if (!a) return;
  const f = forms.get(a.form_id);
  const channel = f?.review_channel_id;
  if (!channel) {
    log.warn({ form: f?.id }, 'Aucun salon de réception configuré pour ce formulaire');
    return;
  }
  const member = await getGuild().members.fetch(a.user_id).catch(() => null);
  const loc = await upsertMessage(channel, { channelId: a.review_channel_id, messageId: a.review_message_id }, { embeds: [reviewEmbed(a, member)], components: reviewButtons(a), allowedMentions: { parse: [] } });
  applications.setReviewMessage(a.id, loc.channelId, loc.messageId);
}

export async function refreshReviewMessage(appId: number): Promise<void> {
  const a = applications.get(appId);
  if (!a?.review_message_id) return;
  const msg = await fetchMessage(a.review_channel_id, a.review_message_id);
  if (!msg) return;
  const member = await getGuild().members.fetch(a.user_id).catch(() => null);
  await msg.edit({ embeds: [reviewEmbed(a, member)], components: reviewButtons(a) });
}

export interface DecisionResult {
  ok: boolean;
  error?: string;
  warnings: string[];
}

/** Décision sur une candidature. Verrou + transition conditionnelle en base : jamais traitée deux fois. */
export async function decide(appId: number, actorId: string, status: Exclude<ApplicationStatus, 'pending'>, reason: string | null, notify = true): Promise<DecisionResult> {
  return withLock(`app:${appId}`, async () => {
    const before = applications.get(appId);
    if (!before) return { ok: false, error: 'Candidature introuvable.', warnings: [] };
    if (before.status === 'accepted' || before.status === 'refused') {
      return { ok: false, error: `Cette candidature a déjà été ${before.status === 'accepted' ? 'acceptée' : 'refusée'} par <@${before.decided_by}>.`, warnings: [] };
    }
    if (status === 'on_hold' && before.status === 'on_hold') return { ok: false, error: 'Elle est déjà en attente.', warnings: [] };
    if (!applications.decide(appId, status, actorId, reason)) return { ok: false, error: 'Elle vient d’être traitée par quelqu’un d’autre.', warnings: [] };
    applications.addEvent(appId, actorId, status, reason);
    const a = applications.get(appId)!;
    const f = forms.get(a.form_id);
    const warnings: string[] = [];
    const guild = getGuild();
    const member = await guild.members.fetch(a.user_id).catch(() => null);
    if (!member && status === 'accepted') warnings.push('Le candidat n’est plus sur le serveur : rôle non attribué.');

    if (status === 'accepted' && member && f?.accepted_role_id) {
      const role = guild.roles.cache.get(f.accepted_role_id);
      const me = guild.members.me!;
      if (!role) warnings.push('Le rôle configuré n’existe plus.');
      else if (role.position >= me.roles.highest.position) warnings.push(`Le rôle ${role.name} est au-dessus du bot : attribue-le manuellement.`);
      else await member.roles.add(role, `Candidature n°${a.id} acceptée`).catch((e) => warnings.push(`Rôle non attribué : ${explainDiscordError(e)}`));
    }

    if (member && notify && f?.dm_on_decision && status !== 'on_hold') {
      const accepted = status === 'accepted';
      const dm = brandEmbed({
        title: accepted ? '🎉 Candidature acceptée !' : 'Candidature refusée',
        description: accepted
          ? `Félicitations, ta candidature **${f.title}** a été acceptée.${f.accepted_role_id ? `\nTu as reçu le rôle <@&${f.accepted_role_id}> sur le serveur ${getSetting('brand.name')}.` : ''}`
          : `Ta candidature **${f.title}** n’a pas été retenue cette fois-ci.${reason ? `\n\n**Motif :** ${reason}` : ''}${f.reapply_days ? `\n\nTu pourras retenter ta chance dans ${f.reapply_days} jour(s).` : ''}`,
        color: accepted ? COLORS.success : COLORS.danger,
      });
      await member.send({ embeds: [dm] }).catch(() => warnings.push('MP fermés : le candidat n’a pas été notifié.'));
    }

    await refreshReviewMessage(a.id).catch(() => undefined);
    await audit({
      type: 'applications',
      action: status,
      actorId,
      target: `Candidature n°${a.id}`,
      message: `Candidature n°${a.id} (<@${a.user_id}>, « ${f?.title ?? '?'} ») : **${APPLICATION_STATUS[status].label}**${reason ? ` — ${reason}` : ''}.`,
      color: APPLICATION_STATUS[status].color,
    });
    return { ok: true, warnings };
  });
}

export async function addApplicationNote(appId: number, authorId: string, content: string): Promise<void> {
  applications.addNote(appId, authorId, content);
  applications.addEvent(appId, authorId, 'note');
  await refreshReviewMessage(appId).catch(() => undefined);
}

export function statsSummary(formId?: number): string {
  const s = applications.stats(formId);
  const decided = s.accepted + s.refused;
  return [
    `📥 **${s.total}** reçue(s)`,
    `⏳ ${s.pending} en attente d’examen • ⏸️ ${s.on_hold} mise(s) en attente`,
    `✅ ${s.accepted} acceptée(s) • ❌ ${s.refused} refusée(s)`,
    decided ? `📈 Taux d’acceptation : **${Math.round((s.accepted / decided) * 100)} %**` : null,
    s.avgDecisionMs ? `⏱️ Délai moyen de décision : ${formatDuration(s.avgDecisionMs)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}
