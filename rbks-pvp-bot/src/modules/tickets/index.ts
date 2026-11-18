import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from 'discord.js';
import type { BotModule, ComponentInteraction } from '../../bot/types';
import { cid } from '../../bot/types';
import { ephemeral, fail, requireFeature, deferEphemeral, openModal } from '../../bot/reply';
import { brandEmbed, infoEmbed, successEmbed, warnEmbed } from '../../bot/ui/embeds';
import { can } from '../../core/permissions';
import { formatDate } from '../../core/time';
import { truncate } from '../../core/text';
import { reasons, tickets } from './tickets.repo';
import {
  addMemberToTicket,
  checkCanOpen,
  claimTicket,
  closeTicket,
  createTicket,
  deleteArchivedTicketChannel,
  publishTicketPanel,
  removeMemberFromTicket,
} from './tickets.service';

async function handle(i: ComponentInteraction, action: string, args: string[]) {
  const id = Number(args[0]);
  switch (action) {
    case 'open': {
      const blocked = checkCanOpen(i.user.id, false);
      if (blocked) return fail(i, blocked);
      const list = reasons.list(true);
      if (!list.length) return fail(i, 'Aucun motif de ticket n’est configuré. Préviens le staff.');
      const select = new StringSelectMenuBuilder()
        .setCustomId(cid('ticket', 'reason'))
        .setPlaceholder('Choisis le motif de ta demande')
        .addOptions(list.slice(0, 25).map((r) => ({ label: truncate(r.label, 100), value: String(r.id), description: r.description ? truncate(r.description, 100) : undefined, emoji: r.emoji || undefined })));
      return ephemeral(i, { embeds: [infoEmbed('Quel est le motif de ta demande ?')], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] });
    }
    case 'reason': {
      if (!i.isStringSelectMenu()) return;
      const reason = reasons.get(Number(i.values[0]));
      if (!reason) return fail(i, 'Motif introuvable.');
      const modal = new ModalBuilder()
        .setCustomId(cid('ticket', 'create', reason.id))
        .setTitle(truncate(`Ticket — ${reason.label}`, 45))
        .addLabelComponents(
          new LabelBuilder().setLabel('Sujet').setTextInputComponent(new TextInputBuilder().setCustomId('subject').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true).setPlaceholder('En quelques mots')),
          new LabelBuilder()
            .setLabel('Décris ta demande')
            .setTextInputComponent(new TextInputBuilder().setCustomId('details').setStyle(TextInputStyle.Paragraph).setMaxLength(1500).setRequired(true).setPlaceholder('Donne un maximum de détails (pseudo Roblox, captures, contexte…)')),
        );
      return openModal(i, modal);
    }
    case 'create': {
      if (!i.isModalSubmit()) return;
      const blocked = checkCanOpen(i.user.id, true);
      if (blocked) return fail(i, blocked);
      await deferEphemeral(i);
      const res = await createTicket(i.member, id, i.fields.getTextInputValue('subject').trim(), i.fields.getTextInputValue('details').trim());
      if (!res.ok) return fail(i, res.error);
      return ephemeral(i, successEmbed(`Ton ticket est ouvert : <#${res.channelId}>`));
    }
  }

  // Actions sur un ticket existant.
  const t = tickets.get(id);
  if (!t) return fail(i, 'Ticket introuvable.');
  const isStaff = can(i.member, 'tickets.handle');
  switch (action) {
    case 'claim': {
      if (!(await requireFeature(i, 'tickets.handle'))) return;
      const err = await claimTicket(t, i.user.id);
      return err ? fail(i, err) : ephemeral(i, 'Tu as pris en charge ce ticket.');
    }
    case 'add': {
      if (!(await requireFeature(i, 'tickets.handle'))) return;
      const sel = new UserSelectMenuBuilder().setCustomId(cid('ticket', 'adduser', t.id)).setPlaceholder('Membre à ajouter').setMinValues(1).setMaxValues(5);
      return ephemeral(i, { embeds: [infoEmbed('Qui veux-tu ajouter à ce ticket ?')], components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(sel)] });
    }
    case 'adduser': {
      if (!i.isUserSelectMenu() || !(await requireFeature(i, 'tickets.handle'))) return;
      await i.deferUpdate();
      for (const uid of i.values) await addMemberToTicket(t, uid, i.user.id);
      return i.editReply({ embeds: [successEmbed(`${i.values.map((v) => `<@${v}>`).join(', ')} ajouté(s).`)], components: [] });
    }
    case 'note': {
      if (!(await requireFeature(i, 'tickets.handle'))) return;
      return openModal(i, 
        new ModalBuilder()
          .setCustomId(cid('ticket', 'notesubmit', t.id))
          .setTitle(`Note interne — ticket n°${t.id}`)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel('Note (visible du staff uniquement)')
              .setTextInputComponent(new TextInputBuilder().setCustomId('note').setStyle(TextInputStyle.Paragraph).setMaxLength(1500).setRequired(true)),
          ),
      );
    }
    case 'notesubmit': {
      if (!i.isModalSubmit() || !(await requireFeature(i, 'tickets.handle'))) return;
      tickets.addNote(t.id, i.user.id, i.fields.getTextInputValue('note').trim());
      return ephemeral(i, 'Note interne enregistrée. Elle n’est pas visible par le joueur.');
    }
    case 'notes': {
      if (!(await requireFeature(i, 'tickets.handle'))) return;
      const notes = tickets.notes(t.id);
      const e = brandEmbed({ title: `📋 Notes internes — ticket n°${t.id}`, description: notes.length ? undefined : 'Aucune note pour le moment.' });
      for (const n of notes.slice(-10)) e.addFields({ name: `${formatDate(n.created_at)}`, value: truncate(`<@${n.author_id}> : ${n.content}`, 1024) });
      return ephemeral(i, e);
    }
    case 'close': {
      if (!isStaff && i.user.id !== t.user_id) return fail(i, 'Seuls le créateur du ticket et le staff peuvent le fermer.');
      if (t.status === 'closed') return fail(i, 'Ce ticket est déjà fermé.');
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(cid('ticket', 'closeconfirm', t.id)).setLabel('Confirmer la fermeture').setEmoji('🔒').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(cid('ticket', 'closereason', t.id)).setLabel('Fermer avec une raison').setEmoji('✍️').setStyle(ButtonStyle.Secondary),
      );
      return ephemeral(i, { embeds: [warnEmbed('Le salon sera fermé et un transcript sera enregistré. Continuer ?', 'Fermer le ticket')], components: [row] });
    }
    case 'closereason': {
      if (!isStaff && i.user.id !== t.user_id) return fail(i, 'Action non autorisée.');
      return openModal(i, 
        new ModalBuilder()
          .setCustomId(cid('ticket', 'closeconfirm', t.id))
          .setTitle(`Fermer le ticket n°${t.id}`)
          .addLabelComponents(new LabelBuilder().setLabel('Raison de la fermeture').setTextInputComponent(new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true))),
      );
    }
    case 'closeconfirm': {
      if (!isStaff && i.user.id !== t.user_id) return fail(i, 'Action non autorisée.');
      const reason = i.isModalSubmit() ? i.fields.getTextInputValue('reason').trim() : null;
      if (i.isButton()) await i.update({ embeds: [infoEmbed('Fermeture en cours…')], components: [] });
      else await deferEphemeral(i);
      const err = await closeTicket(t.id, i.user.id, reason);
      if (err) return fail(i, err);
      return ephemeral(i, 'Ticket fermé. Le transcript a été enregistré dans les logs.');
    }
    case 'delete': {
      if (!(await requireFeature(i, 'tickets.handle'))) return;
      await ephemeral(i, 'Suppression du salon…');
      return deleteArchivedTicketChannel(t);
    }
  }
}

const ticketCommand = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('Gestion des tickets')
  .addSubcommand((s) => s.setName('add').setDescription('Ajouter un membre au ticket actuel').addUserOption((o) => o.setName('membre').setDescription('Membre à ajouter').setRequired(true)))
  .addSubcommand((s) => s.setName('remove').setDescription('Retirer un membre du ticket actuel').addUserOption((o) => o.setName('membre').setDescription('Membre à retirer').setRequired(true)))
  .addSubcommand((s) => s.setName('claim').setDescription('Prendre en charge le ticket actuel'))
  .addSubcommand((s) => s.setName('close').setDescription('Fermer le ticket actuel').addStringOption((o) => o.setName('raison').setDescription('Raison de la fermeture').setMaxLength(500)))
  .addSubcommand((s) => s.setName('panel').setDescription('Publier ou mettre à jour le panneau d’ouverture des tickets'));

export const ticketsModule: BotModule = {
  name: 'tickets',
  components: [{ prefix: 'ticket', handle }],
  commands: [
    {
      data: ticketCommand,
      category: '🎫 Support',
      help: [
        { usage: '/ticket add|remove <membre>', description: 'Gérer les membres d’un ticket', feature: 'tickets.handle' },
        { usage: '/ticket claim', description: 'Prendre en charge le ticket', feature: 'tickets.handle' },
        { usage: '/ticket close [raison]', description: 'Fermer le ticket (créateur ou staff)' },
        { usage: '/ticket panel', description: 'Republier le panneau des tickets', feature: 'tickets.manage' },
      ],
      async execute(i) {
        const sub = i.options.getSubcommand();
        if (sub === 'panel') {
          if (!(await requireFeature(i, 'tickets.manage'))) return;
          await deferEphemeral(i);
          const loc = await publishTicketPanel();
          return ephemeral(i, `Panneau publié dans <#${loc.channelId}>.`);
        }
        const t = tickets.byChannel(i.channelId);
        if (!t || t.status === 'closed') return fail(i, 'Cette commande s’utilise dans un salon de ticket ouvert.');
        if (sub === 'close') {
          if (!can(i.member, 'tickets.handle') && i.user.id !== t.user_id) return fail(i, 'Action non autorisée.');
          await deferEphemeral(i);
          const err = await closeTicket(t.id, i.user.id, i.options.getString('raison'));
          return err ? fail(i, err) : ephemeral(i, 'Ticket fermé.');
        }
        if (!(await requireFeature(i, 'tickets.handle'))) return;
        if (sub === 'claim') {
          const err = await claimTicket(t, i.user.id);
          return err ? fail(i, err) : ephemeral(i, 'Ticket pris en charge.');
        }
        const user = i.options.getUser('membre', true);
        await deferEphemeral(i);
        if (sub === 'add') await addMemberToTicket(t, user.id, i.user.id);
        else await removeMemberFromTicket(t, user.id, i.user.id);
        return ephemeral(i, 'C’est fait.');
      },
    },
  ],
};
