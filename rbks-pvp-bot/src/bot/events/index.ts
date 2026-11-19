import { AuditLogEvent, Events, type Client, type GuildMember, type PartialGuildMember } from 'discord.js';
import { env } from '../../config/env';
import { COLORS } from '../../config/constants';
import { getSetting } from '../../core/settings';
import { roleId } from '../../core/resources';
import { discordTs } from '../../core/time';
import { childLogger } from '../../core/logger';
import { brandEmbed } from '../ui/embeds';
import { audit } from '../../modules/audit/audit';
import { tickets } from '../../modules/tickets/tickets.repo';
import { attachWelcome } from '../../modules/welcome';

const log = childLogger('events');

export function attachEvents(client: Client): void {
  // Arrivées/départs : le module bienvenue détecte l'invitation utilisée, puis on applique les rôles et on journalise.
  attachWelcome(
    client,
    async (member, join) => {
      if (getSetting('members.autoroleOnJoin') && !member.user.bot) {
        const r = roleId('member');
        if (r) await member.roles.add(r, 'Attribution automatique').catch((e) => log.warn({ err: e }, 'Rôle Membre non attribué'));
      }
      if (member.user.bot) {
        const r = roleId('bots');
        if (r) await member.roles.add(r).catch(() => undefined);
      }
      const via = join.inviterId ? `<@${join.inviterId}>${join.code ? ` (lien \`${join.code}\`)` : ''}` : join.source === 'vanity' ? 'lien personnalisé du serveur' : 'inconnu';
      await audit({
        type: 'members',
        action: 'join',
        actorId: member.id,
        message: `${member} a rejoint le serveur (invité par : ${via}).`,
        embed: brandEmbed({ title: '👋 Arrivée', description: `${member} (${member.user.tag})`, color: COLORS.success })
          .setThumbnail(member.displayAvatarURL())
          .addFields(
            { name: 'Compte créé', value: discordTs(member.user.createdTimestamp, 'R'), inline: true },
            { name: 'Invité par', value: via, inline: true },
            { name: 'Membres', value: String(member.guild.memberCount), inline: true },
          ),
      });
    },
    async (member: GuildMember | PartialGuildMember) => {
      await audit({
        type: 'members',
        action: 'leave',
        actorId: member.id,
        message: `${member.user?.tag ?? member.id} a quitté le serveur.`,
        embed: brandEmbed({ title: '🚪 Départ', description: `<@${member.id}> (${member.user?.tag ?? member.id})`, color: COLORS.muted }).addFields(
          { name: 'Arrivé', value: member.joinedTimestamp ? discordTs(member.joinedTimestamp, 'R') : '—', inline: true },
          { name: 'Membres', value: String(member.guild.memberCount), inline: true },
        ),
      });
    },
  );

  // Sanctions : lues depuis le journal d'audit Discord (bannissements, expulsions, exclusions temporaires).
  client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
    if (guild.id !== env().GUILD_ID) return;
    const target = entry.targetId ? `<@${entry.targetId}>` : '—';
    const reason = entry.reason ? `\nRaison : ${entry.reason}` : '';
    let text: string | null = null;
    let color: number = COLORS.danger;
    switch (entry.action) {
      case AuditLogEvent.MemberBanAdd:
        text = `🔨 ${target} a été **banni**${reason}`;
        break;
      case AuditLogEvent.MemberBanRemove:
        text = `♻️ ${target} a été **débanni**${reason}`;
        color = COLORS.success;
        break;
      case AuditLogEvent.MemberKick:
        text = `👢 ${target} a été **expulsé**${reason}`;
        break;
      case AuditLogEvent.MemberUpdate: {
        const change = entry.changes.find((c) => c.key === 'communication_disabled_until');
        if (!change) return;
        text = change.new ? `🔇 ${target} est **exclu temporairement** jusqu’à ${discordTs(new Date(String(change.new)).getTime(), 'f')}${reason}` : `🔊 Fin de l’exclusion temporaire de ${target}${reason}`;
        color = change.new ? COLORS.warning : COLORS.success;
        break;
      }
      default:
        return;
    }
    await audit({ type: 'sanctions', action: String(entry.action), actorId: entry.executorId, target, message: text, color });
  });

  // Un salon de ticket supprimé à la main : on ferme le ticket en base.
  client.on(Events.ChannelDelete, (channel) => {
    if (!('guildId' in channel) || channel.guildId !== env().GUILD_ID) return;
    const t = tickets.byChannel(channel.id);
    if (!t) return;
    if (t.status !== 'closed') tickets.markClosed(t.id, client.user!.id, 'Salon supprimé manuellement');
    tickets.setChannelNull(t.id);
  });
}
