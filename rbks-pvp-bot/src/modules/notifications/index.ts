import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, StringSelectMenuBuilder, type GuildMember } from 'discord.js';
import { NOTIFICATION_TYPES } from '../../config/layout';
import type { BotModule, ComponentInteraction } from '../../bot/types';
import { cid } from '../../bot/types';
import { ephemeral, fail } from '../../bot/reply';
import { brandEmbed, successEmbed } from '../../bot/ui/embeds';
import { publishPanel } from '../../bot/panels';
import { roleId } from '../../core/resources';
import { rateLimit } from '../../core/guards';

/** Rôle Discord associé à chaque type de notification (créé par /setup, modifiable dans le panel). */
export function notificationRoles(): { key: string; label: string; emoji: string; description: string; roleId: string | null }[] {
  return NOTIFICATION_TYPES.map((n) => ({ key: n.key, label: n.label, emoji: n.emoji, description: n.description, roleId: roleId(n.role) }));
}

export function notificationRoleId(key: string): string | null {
  return notificationRoles().find((n) => n.key === key)?.roleId ?? null;
}

function personalSelect(member: GuildMember) {
  const available = notificationRoles().filter((n) => n.roleId && member.guild.roles.cache.has(n.roleId));
  return new StringSelectMenuBuilder()
    .setCustomId(cid('notif', 'set'))
    .setPlaceholder('Choisis tes notifications…')
    .setMinValues(0)
    .setMaxValues(Math.max(1, available.length))
    .addOptions(available.map((n) => ({ label: n.label, value: n.key, description: n.description, emoji: n.emoji, default: member.roles.cache.has(n.roleId!) })));
}

function summary(member: GuildMember): string {
  const mine = notificationRoles().filter((n) => n.roleId && member.roles.cache.has(n.roleId));
  return mine.length ? mine.map((n) => `${n.emoji} ${n.label}`).join('\n') : '🔕 Aucune notification.';
}

export async function publishNotificationPanel() {
  const e = brandEmbed({
    title: '🔔 Tes notifications',
    description: `Choisis ce dont tu veux être prévenu. Tu peux changer d’avis à tout moment.\n\n${NOTIFICATION_TYPES.map((n) => `${n.emoji} **${n.label}** — ${n.description}`).join('\n')}`,
    timestamp: false,
  });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(cid('notif', 'open')).setLabel('Gérer mes notifications').setEmoji('🔔').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(cid('notif', 'all')).setLabel('Tout activer').setEmoji('✅').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('notif', 'none')).setLabel('Tout désactiver').setEmoji('🔕').setStyle(ButtonStyle.Secondary),
  );
  return publishPanel('notifications', 'notifications', { embeds: [e], components: [row] });
}

/** Applique exactement la sélection du membre (ajoute/retire uniquement les rôles de notification). */
async function apply(member: GuildMember, keys: string[]): Promise<string[]> {
  const errors: string[] = [];
  const me = member.guild.members.me!;
  for (const n of notificationRoles()) {
    if (!n.roleId) continue;
    const role = member.guild.roles.cache.get(n.roleId);
    if (!role) continue;
    if (role.position >= me.roles.highest.position) {
      errors.push(n.label);
      continue;
    }
    const want = keys.includes(n.key);
    const has = member.roles.cache.has(role.id);
    if (want && !has) await member.roles.add(role, 'Préférences de notification').catch(() => errors.push(n.label));
    if (!want && has) await member.roles.remove(role, 'Préférences de notification').catch(() => errors.push(n.label));
  }
  return errors;
}

async function handle(i: ComponentInteraction, action: string) {
  if (!rateLimit(`notif:${i.user.id}`, 6, 30_000)) return fail(i, 'Trop de changements d’affilée, réessaie dans quelques secondes.');
  const member = await i.member.fetch();
  if (action === 'open') {
    const select = personalSelect(member);
    if (!select.options.length) return fail(i, 'Les rôles de notification ne sont pas encore configurés (/setup).');
    return ephemeral(i, { embeds: [brandEmbed({ title: '🔔 Mes notifications', description: summary(member), timestamp: false })], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] });
  }
  let keys: string[] = [];
  if (action === 'set' && i.isStringSelectMenu()) keys = i.values;
  else if (action === 'all') keys = notificationRoles().map((n) => n.key);
  else if (action !== 'none') return;
  if (i.isStringSelectMenu()) await i.deferUpdate();
  const errors = await apply(member, keys);
  const fresh = await member.fetch(true);
  const embed = errors.length
    ? brandEmbed({ title: '🔔 Mes notifications', description: `${summary(fresh)}\n\n⚠️ Impossible de modifier : ${errors.join(', ')} (préviens le staff).` })
    : successEmbed(summary(fresh), 'Préférences enregistrées');
  if (i.isStringSelectMenu()) return i.editReply({ embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(personalSelect(fresh))] });
  return ephemeral(i, embed);
}

export const notificationsModule: BotModule = {
  name: 'notifications',
  components: [{ prefix: 'notif', handle: (i, action) => handle(i, action) }],
  commands: [
    {
      data: new SlashCommandBuilder().setName('notifications').setDescription('Choisir les notifications que tu veux recevoir'),
      category: '💬 Communauté',
      help: [{ usage: '/notifications', description: 'Choisir tes rôles de notification' }],
      execute: (i) => handle(i as unknown as ComponentInteraction, 'open'),
    },
  ],
};
