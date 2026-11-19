import { DiscordAPIError, type EmbedBuilder, type Guild } from 'discord.js';
import { COLORS } from '../../config/constants';
import { getGuild } from '../../bot/client';
import { brandEmbed } from '../../bot/ui/embeds';
import { getSetting } from '../../core/settings';
import { sanitizeMentions, truncate } from '../../core/text';
import { childLogger } from '../../core/logger';
import { audit } from '../audit/audit';
import { campaigns, recipients, type Campaign, type CampaignCounts } from './massdm.repo';

const log = childLogger('massdm');

/** Délai entre deux messages privés : reste largement sous les limites anti-spam de Discord. */
export const SEND_DELAY_MS = 1500;

export const PLACEHOLDERS = '{membre} (mention), {pseudo}, {cle}, {roblox}, {serveur}';

export interface DmContext {
  userId: string;
  displayName: string;
  key: string | null;
  roblox: string | null;
}

export function renderText(template: string, ctx: DmContext): string {
  return template
    .replace(/\{membre\}/gi, `<@${ctx.userId}>`)
    .replace(/\{pseudo\}/gi, ctx.displayName)
    .replace(/\{cl[eé]\}/gi, ctx.key ? `\`${ctx.key}\`` : '—')
    .replace(/\{roblox\}/gi, ctx.roblox ?? '—')
    .replace(/\{serveur\}/gi, getSetting('brand.name'));
}

/** Message privé envoyé à chaque destinataire. La clé est toujours affichée dans un champ dédié, facile à copier. */
export function dmEmbed(c: Campaign, ctx: DmContext): EmbedBuilder {
  const e = brandEmbed({ title: c.title || getSetting('brand.name'), description: sanitizeMentions(renderText(c.message, ctx)) || undefined });
  if (c.with_keys && ctx.key) {
    e.addFields({ name: '🔑 Ta clé d’accès personnelle', value: `\`\`\`\n${ctx.key}\n\`\`\`Elle est **personnelle** : ne la partage avec personne. Retrouve-la à tout moment avec \`/macle\`.` });
  }
  return e;
}

/** Membres (hors bots) possédant le rôle ciblé. */
export async function roleMembers(guild: Guild, roleId: string): Promise<{ id: string; tag: string }[]> {
  await guild.members.fetch().catch(() => undefined);
  const role = guild.roles.cache.get(roleId);
  if (!role) throw new Error('Le rôle ciblé n’existe plus.');
  return [...role.members.values()].filter((m) => !m.user.bot).map((m) => ({ id: m.id, tag: m.user.tag }));
}

/** Ajoute au lot les membres qui ont reçu le rôle depuis (les anciens destinataires ne sont pas touchés). */
export async function refreshRecipients(campaignId: number): Promise<{ added: number; counts: CampaignCounts }> {
  const c = campaigns.get(campaignId);
  if (!c) throw new Error('Lot introuvable');
  const members = await roleMembers(getGuild(), c.role_id);
  const added = recipients.addMissing(c, members);
  return { added, counts: campaigns.counts(c.id) };
}

const running = new Set<number>();
export const isRunning = (id: number) => running.has(id);

export type Progress = (counts: CampaignCounts) => void | Promise<void>;

/**
 * Envoie les messages en attente, un par un. L'état est enregistré après chaque envoi :
 * si le bot redémarre au milieu, l'envoi reprend là où il s'était arrêté (voir resumeCampaigns).
 */
export async function runCampaign(campaignId: number, onProgress?: Progress): Promise<CampaignCounts | null> {
  if (running.has(campaignId)) return null;
  running.add(campaignId);
  try {
    const c = campaigns.get(campaignId);
    if (!c) return null;
    campaigns.setStatus(c.id, 'sending');
    const guild = getGuild();
    let i = 0;
    for (const r of recipients.pending(c.id)) {
      const member = await guild.members.fetch(r.user_id).catch(() => null);
      if (!member) {
        recipients.markFailed(c.id, r.user_id, 'a quitté le serveur');
      } else {
        try {
          await member.send({ embeds: [dmEmbed(c, { userId: member.id, displayName: member.displayName, key: r.access_key, roblox: recipients.robloxOf(member.id) })] });
          recipients.markSent(c.id, r.user_id);
        } catch (e) {
          const msg = e instanceof DiscordAPIError && e.code === 50007 ? 'messages privés fermés' : truncate(String((e as Error).message), 200);
          recipients.markFailed(c.id, r.user_id, msg);
        }
        await new Promise((res) => setTimeout(res, SEND_DELAY_MS));
      }
      if (++i % 5 === 0 && onProgress) await Promise.resolve(onProgress(campaigns.counts(c.id))).catch(() => undefined);
    }
    campaigns.setStatus(c.id, 'done');
    const counts = campaigns.counts(c.id);
    const failed = recipients.list(c.id).filter((r) => r.status === 'failed');
    await audit({
      type: 'admin',
      action: 'massdm',
      actorId: c.created_by,
      target: c.name,
      message: `Envoi groupé « ${c.name} » terminé : ${counts.sent} reçu(s), ${counts.failed} échec(s) sur ${counts.total}.${
        failed.length ? `\nÉchecs : ${truncate(failed.map((r) => `<@${r.user_id}> (${r.error})`).join(', '), 1500)}` : ''
      }`,
      color: counts.failed ? COLORS.warning : COLORS.success,
    });
    return counts;
  } catch (e) {
    log.error({ err: e, campaignId }, 'Envoi groupé interrompu');
    throw e;
  } finally {
    running.delete(campaignId);
  }
}

/** Au démarrage : reprend les envois interrompus par un redémarrage ou une mise à jour. */
export function resumeCampaigns(): void {
  for (const c of campaigns.list().filter((x) => x.status === 'sending')) {
    log.info({ campaign: c.name }, 'Reprise d’un envoi groupé interrompu');
    void runCampaign(c.id).catch(() => undefined);
  }
}

// ───────────── Exports pour le jeu Roblox ─────────────

function rows(campaignId: number) {
  return recipients
    .list(campaignId)
    .filter((r) => r.access_key)
    .map((r) => ({ key: r.access_key!, discordId: r.user_id, discordTag: r.user_tag ?? '', roblox: recipients.robloxOf(r.user_id) ?? '', status: r.status }));
}

const csvCell = (v: string) => (/[",;\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function exportCsv(campaignId: number): string {
  const lines = ['cle,discord_id,discord_pseudo,roblox,statut_envoi'];
  for (const r of rows(campaignId)) lines.push([r.key, r.discordId, r.discordTag, r.roblox, r.status].map(csvCell).join(','));
  return lines.join('\n') + '\n';
}

export function exportJson(campaignId: number): string {
  const c = campaigns.get(campaignId)!;
  return JSON.stringify({ lot: c.name, generatedAt: new Date().toISOString(), keys: rows(campaignId) }, null, 2) + '\n';
}

/**
 * ModuleScript Roblox prêt à coller dans ServerStorage (jamais dans ReplicatedStorage : les joueurs pourraient le lire).
 * Utilisation côté serveur : local Keys = require(ServerStorage.RBKSAccessKeys); if Keys[saisie] then ... end
 */
export function exportLua(campaignId: number): string {
  const c = campaigns.get(campaignId)!;
  const list = rows(campaignId);
  const esc = (s: string) => s.replace(/[\\"]/g, (ch) => `\\${ch}`).replace(/[\r\n]/g, ' ');
  return [
    `-- RBKS PVP : clés d'accès du lot "${esc(c.name)}" (${list.length} clé(s)), générées le ${new Date().toISOString().slice(0, 10)}.`,
    '-- À placer dans un ModuleScript de ServerStorage (jamais côté client).',
    '-- Valeur = identifiant Discord du membre à qui la clé a été envoyée.',
    'return {',
    ...list.map((r) => `\t["${r.key}"] = "${r.discordId}", -- ${esc(r.discordTag)}${r.roblox ? ` / Roblox : ${esc(r.roblox)}` : ''}`),
    '}',
    '',
  ].join('\n');
}
