import {
  LabelBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Attachment,
  type AutocompleteInteraction,
} from 'discord.js';
import { PUBLICATION_KINDS, isKeyOf, type PublicationKind } from '../../config/constants';
import { db } from '../../db';
import type { BotModule, ComponentInteraction } from '../../bot/types';
import { cid } from '../../bot/types';
import { deferEphemeral, ephemeral, fail, openModal, requireFeature } from '../../bot/reply';
import { brandEmbed } from '../../bot/ui/embeds';
import { fetchMessage, fetchTextChannel } from '../../bot/messages';
import { channelId } from '../../core/resources';
import { discordTs, parseDate } from '../../core/time';
import { isHttpUrl, splitLines, truncate } from '../../core/text';
import { audit } from '../audit/audit';
import { notificationRoleId } from '../notifications';
import type { ChannelKey } from '../../config/layout';

export interface Publication {
  id: number;
  kind: PublicationKind;
  version: string | null;
  title: string;
  description: string;
  features: string;
  fixes: string;
  balance: string;
  image_url: string | null;
  publish_date: number | null;
  ping: number;
  channel_id: string | null;
  message_id: string | null;
  author_id: string | null;
  created_at: number;
  updated_at: number;
}

export type PublicationInput = Pick<Publication, 'kind' | 'version' | 'title' | 'description' | 'features' | 'fixes' | 'balance' | 'image_url' | 'publish_date'> & { ping: boolean };

export const publications = {
  get: (id: number) => db().prepare('SELECT * FROM publications WHERE id = ?').get(id) as Publication | undefined,
  list: (kind?: string, limit = 50) =>
    (kind ? db().prepare('SELECT * FROM publications WHERE kind = ? ORDER BY id DESC LIMIT ?').all(kind, limit) : db().prepare('SELECT * FROM publications ORDER BY id DESC LIMIT ?').all(limit)) as Publication[],
  search: (kinds: string[], q: string) =>
    db()
      .prepare(`SELECT * FROM publications WHERE kind IN (${kinds.map(() => '?').join(',')}) AND (title LIKE ? OR version LIKE ?) ORDER BY id DESC LIMIT 25`)
      .all(...kinds, `%${q}%`, `%${q}%`) as Publication[],
  create(p: PublicationInput, authorId: string): number {
    const t = Date.now();
    return Number(
      db()
        .prepare('INSERT INTO publications (kind, version, title, description, features, fixes, balance, image_url, publish_date, ping, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(p.kind, p.version, p.title, p.description, p.features, p.fixes, p.balance, p.image_url, p.publish_date, p.ping ? 1 : 0, authorId, t, t).lastInsertRowid,
    );
  },
  update(id: number, p: Partial<PublicationInput>): void {
    const cur = publications.get(id)!;
    const n = { ...cur, ...p, ping: p.ping === undefined ? cur.ping : p.ping ? 1 : 0 };
    db()
      .prepare('UPDATE publications SET kind = ?, version = ?, title = ?, description = ?, features = ?, fixes = ?, balance = ?, image_url = ?, publish_date = ?, ping = ?, updated_at = ? WHERE id = ?')
      .run(n.kind, n.version, n.title, n.description, n.features, n.fixes, n.balance, n.image_url, n.publish_date, n.ping, Date.now(), id);
  },
  setMessage: (id: number, ch: string, msg: string, image: string | null) => db().prepare('UPDATE publications SET channel_id = ?, message_id = ?, image_url = COALESCE(?, image_url) WHERE id = ?').run(ch, msg, image, id),
};

const bullet = (s: string) => splitLines(s).map((l) => `• ${l}`).join('\n');

export function publicationEmbed(p: Publication) {
  const k = PUBLICATION_KINDS[p.kind];
  const title = p.kind === 'patchnote' && p.version ? `${k.emoji} Patch note ${p.version} — ${p.title}` : `${k.emoji} ${p.title}`;
  const e = brandEmbed({ title, description: p.description || undefined, timestamp: false, footerExtra: k.label });
  if (p.features.trim()) e.addFields({ name: '✨ Nouveautés', value: truncate(bullet(p.features), 1024) });
  if (p.fixes.trim()) e.addFields({ name: '🛠️ Corrections', value: truncate(bullet(p.fixes), 1024) });
  if (p.balance.trim()) e.addFields({ name: '⚖️ Équilibrage', value: truncate(bullet(p.balance), 1024) });
  if (p.version && p.kind !== 'patchnote') e.addFields({ name: 'Version', value: p.version, inline: true });
  if (p.publish_date) e.addFields({ name: 'Date', value: discordTs(p.publish_date, 'D'), inline: true });
  if (p.image_url) e.setImage(p.image_url);
  e.setTimestamp(p.publish_date ?? p.created_at);
  return e;
}

/** Publie (ou met à jour) une publication dans le salon correspondant à son type. */
export async function publishPublication(id: number, upload?: { url: string; name: string } | null): Promise<Publication> {
  const p = publications.get(id)!;
  const k = PUBLICATION_KINDS[p.kind];
  const embed = publicationEmbed(p);
  if (upload) embed.setImage(`attachment://${upload.name}`);
  const existing = await fetchMessage(p.channel_id, p.message_id);
  if (existing) {
    // Image déjà jointe au message : on la réutilise (les liens CDN de Discord expirent).
    const attached = existing.attachments.find((a) => a.contentType?.startsWith('image/'));
    if (!upload && attached && (!p.image_url || p.image_url.includes('discordapp'))) embed.setImage(`attachment://${attached.name}`);
    await existing.edit({ embeds: [embed], ...(upload ? { files: [{ attachment: upload.url, name: upload.name }] } : {}) });
    publications.update(id, {});
    return publications.get(id)!;
  }
  const target = channelId(k.channel as ChannelKey);
  const ch = await fetchTextChannel(target);
  if (!ch) throw new Error(`Salon ${k.label.toLowerCase()} non configuré (/setup installer ou panel → Réglages).`);
  const role = p.ping ? notificationRoleId(k.notif) : null;
  const msg = await ch.send({ content: role ? `<@&${role}>` : undefined, embeds: [embed], files: upload ? [{ attachment: upload.url, name: upload.name }] : [], allowedMentions: { roles: role ? [role] : [] } });
  // L'image envoyée en pièce jointe est servie par Discord ; on mémorise son URL pour les modifications.
  const stored = msg.embeds[0]?.image?.url ?? null;
  publications.setMessage(id, ch.id, msg.id, stored);
  if (ch.isTextBased() && 'crosspostable' in msg && msg.crosspostable) await msg.crosspost().catch(() => undefined);
  await audit({ type: 'publications', action: `${p.kind}_publish`, actorId: p.author_id, target: p.title, message: `${k.label} publiée : « ${p.title} » dans <#${ch.id}>.` });
  return publications.get(id)!;
}

// ───────────── Fenêtres modales ─────────────

const field = (id: string, style: TextInputStyle, required: boolean, max: number, value?: string | null, placeholder?: string) => {
  const t = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(required).setMaxLength(max);
  if (value) t.setValue(value.slice(0, max));
  if (placeholder) t.setPlaceholder(placeholder);
  return t;
};

export function patchnoteModal(customId: string, p?: Publication) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(p ? `Modifier le patch note ${p.version ?? ''}`.trim() : 'Nouveau patch note')
    .addLabelComponents(
      new LabelBuilder().setLabel('Titre').setTextInputComponent(field('title', TextInputStyle.Short, true, 150, p?.title, 'Mise à jour Raiton')),
      new LabelBuilder().setLabel('Description').setTextInputComponent(field('description', TextInputStyle.Paragraph, false, 1500, p?.description)),
      new LabelBuilder().setLabel('Nouveautés (une par ligne)').setTextInputComponent(field('features', TextInputStyle.Paragraph, false, 1000, p?.features)),
      new LabelBuilder().setLabel('Corrections (une par ligne)').setTextInputComponent(field('fixes', TextInputStyle.Paragraph, false, 1000, p?.fixes)),
      new LabelBuilder().setLabel('Équilibrage (une par ligne)').setTextInputComponent(field('balance', TextInputStyle.Paragraph, false, 1000, p?.balance)),
    );
}

export function announcementModal(customId: string, p?: Publication) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(p ? 'Modifier la publication' : 'Nouvelle publication')
    .addLabelComponents(
      new LabelBuilder().setLabel('Titre').setTextInputComponent(field('title', TextInputStyle.Short, true, 200, p?.title)),
      new LabelBuilder().setLabel('Contenu').setTextInputComponent(field('description', TextInputStyle.Paragraph, true, 4000, p?.description)),
      new LabelBuilder().setLabel('Version concernée (facultatif)').setTextInputComponent(field('version', TextInputStyle.Short, false, 20, p?.version)),
    );
}

/** Pièces jointes reçues avec la commande, conservées le temps de remplir la fenêtre (5 minutes). */
const pendingUploads = new Map<string, { url: string; name: string; at: number; external: boolean }>();
function stashUpload(userId: string, a: Attachment | null, externalUrl?: string | null): string {
  if (!a && !externalUrl) return '';
  const key = `${userId}-${Date.now().toString(36)}`;
  pendingUploads.set(key, a ? { url: a.url, name: a.name.replace(/[^\w.-]/g, '_'), at: Date.now(), external: false } : { url: externalUrl!, name: '', at: Date.now(), external: true });
  for (const [k, v] of pendingUploads) if (v.at < Date.now() - 5 * 6e4) pendingUploads.delete(k);
  return key;
}

async function handle(i: ComponentInteraction, action: string, args: string[]) {
  if (!(await requireFeature(i, 'publications.manage')) || !i.isModalSubmit()) return;
  // args : [kind, id|new, version, date, ping, upload]
  const [kindRaw, idRaw, version, dateRaw, ping, uploadKey] = args;
  if (!isKeyOf(PUBLICATION_KINDS, kindRaw)) return fail(i, 'Type de publication inconnu.');
  const kind = kindRaw as PublicationKind;
  const get = (id: string) => {
    try {
      return i.fields.getTextInputValue(id).trim();
    } catch {
      return '';
    }
  };
  const upload = uploadKey ? (pendingUploads.get(uploadKey) ?? null) : null;
  if (uploadKey && !upload) return fail(i, 'L’image a expiré (plus de 5 minutes). Relance la commande.');
  if (uploadKey) pendingUploads.delete(uploadKey);
  await deferEphemeral(i);
  const data: Partial<PublicationInput> = {
    title: get('title'),
    description: get('description'),
    ...(kind === 'patchnote' ? { features: get('features'), fixes: get('fixes'), balance: get('balance') } : { version: get('version') || null }),
  };
  if (version) data.version = decodeURIComponent(version);
  if (dateRaw) data.publish_date = Number(dateRaw);
  if (ping) data.ping = ping === '1';
  if (upload?.external) data.image_url = upload.url;
  let id: number;
  if (action === 'save' && idRaw !== 'new') {
    id = Number(idRaw);
    if (!publications.get(id)) return fail(i, 'Publication introuvable.');
    publications.update(id, data);
  } else {
    id = publications.create({ kind, version: null, features: '', fixes: '', balance: '', image_url: null, publish_date: null, ping: false, description: '', title: '', ...data } as PublicationInput, i.user.id);
  }
  const p = await publishPublication(id, upload && !upload.external ? upload : null);
  if (idRaw !== 'new') await audit({ type: 'publications', action: `${kind}_edit`, actorId: i.user.id, target: p.title, message: `${PUBLICATION_KINDS[kind].label} modifiée : « ${p.title} ».` });
  return ephemeral(i, `${PUBLICATION_KINDS[kind].label} ${idRaw === 'new' ? 'publiée' : 'mise à jour'} dans <#${p.channel_id}>.`);
}

const kindChoices = (Object.keys(PUBLICATION_KINDS) as PublicationKind[]).filter((k) => k !== 'patchnote').map((k) => ({ name: `${PUBLICATION_KINDS[k].emoji} ${PUBLICATION_KINDS[k].label}`, value: k }));

async function pubAutocomplete(i: AutocompleteInteraction<'cached'>, kinds: string[]) {
  await i.respond(publications.search(kinds, String(i.options.getFocused())).map((p) => ({ name: truncate(`${PUBLICATION_KINDS[p.kind].emoji} ${p.version ? p.version + ' — ' : ''}${p.title}`, 100), value: String(p.id) })));
}

export const publicationsModule: BotModule = {
  name: 'publications',
  components: [{ prefix: 'pub', handle }],
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('patchnote')
        .setDescription('Patch notes (salon #patch-note)')
        .addSubcommand((s) =>
          s
            .setName('create')
            .setDescription('Publier un patch note')
            .addStringOption((o) => o.setName('version').setDescription('Numéro de version (ex. V0.2.1)').setRequired(true).setMaxLength(20))
            .addAttachmentOption((o) => o.setName('image').setDescription('Image facultative'))
            .addStringOption((o) => o.setName('date').setDescription('Date de publication (JJ/MM/AAAA, par défaut aujourd’hui)').setMaxLength(20))
            .addBooleanOption((o) => o.setName('notifier').setDescription('Mentionner le rôle « Patch notes » (par défaut : oui)')),
        )
        .addSubcommand((s) =>
          s
            .setName('edit')
            .setDescription('Modifier un patch note')
            .addStringOption((o) => o.setName('patchnote').setDescription('Patch note').setRequired(true).setAutocomplete(true))
            .addAttachmentOption((o) => o.setName('image').setDescription('Nouvelle image')),
        ),
      feature: 'publications.manage',
      category: '📢 Publications',
      help: [{ usage: '/patchnote create|edit', description: 'Publier et modifier les patch notes', feature: 'publications.manage' }],
      autocomplete: (i) => pubAutocomplete(i, ['patchnote']),
      async execute(i) {
        const upload = stashUpload(i.user.id, i.options.getAttachment('image'));
        if (i.options.getAttachment('image') && !i.options.getAttachment('image')!.contentType?.startsWith('image/')) return fail(i, 'Le fichier doit être une image.');
        if (i.options.getSubcommand() === 'edit') {
          const p = publications.get(Number(i.options.getString('patchnote', true)));
          if (!p || p.kind !== 'patchnote') return fail(i, 'Patch note introuvable.');
          return openModal(i, patchnoteModal(cid('pub', 'save', 'patchnote', p.id, '', '', '', upload), p));
        }
        const dateRaw = i.options.getString('date');
        const date = dateRaw ? parseDate(dateRaw) : Date.now();
        if (!date) return fail(i, 'Date invalide (JJ/MM/AAAA).');
        const version = encodeURIComponent(i.options.getString('version', true));
        return openModal(i, patchnoteModal(cid('pub', 'save', 'patchnote', 'new', version, date, (i.options.getBoolean('notifier') ?? true) ? '1' : '0', upload)));
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('announcement')
        .setDescription('Annonces, mises à jour et spoils')
        .addSubcommand((s) =>
          s
            .setName('create')
            .setDescription('Publier une annonce')
            .addStringOption((o) => o.setName('type').setDescription('Type (choisit le salon)').setRequired(true).addChoices(...kindChoices))
            .addAttachmentOption((o) => o.setName('image').setDescription('Image facultative'))
            .addStringOption((o) => o.setName('image_url').setDescription('…ou URL d’image').setMaxLength(500))
            .addBooleanOption((o) => o.setName('notifier').setDescription('Mentionner le rôle de notification correspondant')),
        )
        .addSubcommand((s) =>
          s
            .setName('edit')
            .setDescription('Modifier une annonce')
            .addStringOption((o) => o.setName('publication').setDescription('Publication').setRequired(true).setAutocomplete(true))
            .addAttachmentOption((o) => o.setName('image').setDescription('Nouvelle image')),
        ),
      feature: 'publications.manage',
      category: '📢 Publications',
      help: [{ usage: '/announcement create|edit', description: 'Annonces, mises à jour et spoils', feature: 'publications.manage' }],
      autocomplete: (i) => pubAutocomplete(i, ['announcement', 'update', 'spoil']),
      async execute(i) {
        const att = i.options.getAttachment('image');
        if (att && !att.contentType?.startsWith('image/')) return fail(i, 'Le fichier doit être une image.');
        const url = i.options.getString('image_url');
        if (url && !isHttpUrl(url)) return fail(i, 'URL d’image invalide.');
        const upload = stashUpload(i.user.id, att, url);
        if (i.options.getSubcommand() === 'edit') {
          const p = publications.get(Number(i.options.getString('publication', true)));
          if (!p || p.kind === 'patchnote') return fail(i, 'Publication introuvable.');
          return openModal(i, announcementModal(cid('pub', 'save', p.kind, p.id, '', '', '', upload), p));
        }
        const kind = i.options.getString('type', true) as PublicationKind;
        return openModal(i, announcementModal(cid('pub', 'save', kind, 'new', '', Date.now(), (i.options.getBoolean('notifier') ?? false) ? '1' : '0', upload)));
      },
    },
  ],
};

