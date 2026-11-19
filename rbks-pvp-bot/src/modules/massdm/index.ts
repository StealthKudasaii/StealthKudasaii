import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
} from 'discord.js';
import type { BotModule, ComponentInteraction } from '../../bot/types';
import { cid } from '../../bot/types';
import { deferEphemeral, ephemeral, fail, fromEphemeralMessage, openModal, requireFeature } from '../../bot/reply';
import { brandEmbed, infoEmbed, successEmbed, warnEmbed } from '../../bot/ui/embeds';
import { COLORS } from '../../config/constants';
import { roleId as managedRole } from '../../core/resources';
import { discordTs, formatDuration } from '../../core/time';
import { truncate } from '../../core/text';
import { audit } from '../audit/audit';
import { campaigns, recipients, type Campaign } from './massdm.repo';
import { PLACEHOLDERS, SEND_DELAY_MS, dmEmbed, exportCsv, exportJson, exportLua, isRunning, refreshRecipients, runCampaign } from './massdm.service';

const P = 'mdm';
const STATUS_LABEL: Record<Campaign['status'], string> = { draft: '📝 Brouillon', sending: '📨 Envoi en cours', done: '✅ Envoyé' };

function panel(c: Campaign, viewer: { id: string; displayName: string }, notice?: string) {
  const n = campaigns.counts(c.id);
  const running = isRunning(c.id);
  const info = brandEmbed({
    title: `📨 Envoi groupé — ${c.name}`,
    description: `${notice ? `${notice}\n\n` : ''}Destinataires : membres ayant le rôle <@&${c.role_id}>.\n${c.with_keys ? '🔑 Chaque membre reçoit **sa propre clé d’accès**.' : 'Message sans clé d’accès.'}`,
  }).addFields(
    { name: 'Statut', value: running ? STATUS_LABEL.sending : STATUS_LABEL[c.status], inline: true },
    { name: 'Destinataires', value: String(n.total), inline: true },
    { name: 'Reçus', value: String(n.sent), inline: true },
    { name: 'En attente', value: String(n.pending), inline: true },
    { name: 'Échecs', value: String(n.failed), inline: true },
    { name: 'Durée estimée', value: n.pending ? `~${formatDuration(n.pending * SEND_DELAY_MS + 6e4)}` : '—', inline: true },
    { name: 'Variables utilisables dans le message', value: PLACEHOLDERS },
  );
  const preview = dmEmbed(c, { userId: viewer.id, displayName: viewer.displayName, key: c.with_keys ? 'RBKS-XXXX-XXXX-XXXX' : null, roblox: recipients.robloxOf(viewer.id) });
  preview.setAuthor({ name: 'Aperçu du message privé (exemple avec ton pseudo)' });
  const ready = !!c.message.trim();
  return {
    embeds: [info, preview],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(cid(P, 'send', c.id)).setLabel(`Envoyer (${n.pending})`).setEmoji('📨').setStyle(ButtonStyle.Success).setDisabled(!ready || running || n.pending === 0),
        new ButtonBuilder().setCustomId(cid(P, 'test', c.id)).setLabel('M’envoyer un test').setEmoji('🧪').setStyle(ButtonStyle.Primary).setDisabled(!ready),
        new ButtonBuilder().setCustomId(cid(P, 'edit', c.id)).setLabel('Modifier le message').setEmoji('✏️').setStyle(ButtonStyle.Secondary).setDisabled(running),
        new ButtonBuilder().setCustomId(cid(P, 'refresh', c.id)).setLabel('Ajouter les nouveaux membres').setEmoji('🔄').setStyle(ButtonStyle.Secondary).setDisabled(running),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(cid(P, 'retry', c.id)).setLabel(`Renvoyer aux échecs (${n.failed})`).setEmoji('🔁').setStyle(ButtonStyle.Secondary).setDisabled(running || n.failed === 0),
        new ButtonBuilder().setCustomId(cid(P, 'export', c.id)).setLabel('Exporter les clés').setEmoji('📤').setStyle(ButtonStyle.Secondary).setDisabled(!c.with_keys || n.total === 0),
        new ButtonBuilder().setCustomId(cid(P, 'delete', c.id)).setLabel('Supprimer').setEmoji('🗑️').setStyle(ButtonStyle.Danger).setDisabled(running),
      ),
    ],
  };
}

function messageModal(c: Campaign) {
  const title = new TextInputBuilder().setCustomId('title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200).setPlaceholder('🧪 Ton accès à la bêta de RBKS PVP');
  if (c.title) title.setValue(c.title);
  const msg = new TextInputBuilder()
    .setCustomId('message')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(3500)
    .setPlaceholder('Salut {pseudo} ! Ta candidature a été acceptée. Lance le jeu et entre ta clé {cle} au démarrage.');
  if (c.message) msg.setValue(c.message);
  return new ModalBuilder()
    .setCustomId(cid(P, 'save', c.id))
    .setTitle(truncate(`Message — ${c.name}`, 45))
    .addLabelComponents(
      new LabelBuilder().setLabel('Titre du message').setTextInputComponent(title),
      new LabelBuilder().setLabel('Contenu').setDescription('Variables : {pseudo} {membre} {cle} {roblox} {serveur}').setTextInputComponent(msg),
    );
}

function exportFiles(c: Campaign) {
  const base = c.name.replace(/[^\w-]+/g, '_');
  return [
    new AttachmentBuilder(Buffer.from(exportLua(c.id), 'utf8'), { name: `RBKSAccessKeys-${base}.lua` }),
    new AttachmentBuilder(Buffer.from(exportCsv(c.id), 'utf8'), { name: `cles-${base}.csv` }),
    new AttachmentBuilder(Buffer.from(exportJson(c.id), 'utf8'), { name: `cles-${base}.json` }),
  ];
}

async function show(i: ComponentInteraction, c: Campaign, notice?: string) {
  const payload = panel(campaigns.get(c.id)!, { id: i.user.id, displayName: i.member.displayName }, notice);
  if (fromEphemeralMessage(i) && (i.isMessageComponent() || (i.isModalSubmit() && i.isFromMessage()))) {
    if (i.deferred || i.replied) return i.editReply(payload);
    return i.update(payload);
  }
  if (i.deferred || i.replied) return i.editReply(payload);
  return i.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

async function handle(i: ComponentInteraction, action: string, args: string[]) {
  if (!(await requireFeature(i, 'massdm.manage'))) return;
  const c = campaigns.get(Number(args[0]));
  if (!c) return fail(i, 'Ce lot n’existe plus.');

  switch (action) {
    case 'edit':
      return openModal(i, messageModal(c));
    case 'save': {
      if (!i.isModalSubmit()) return;
      campaigns.setMessage(c.id, i.fields.getTextInputValue('title').trim(), i.fields.getTextInputValue('message').trim());
      if (fromEphemeralMessage(i)) await i.deferUpdate();
      else await deferEphemeral(i);
      const { counts } = await refreshRecipients(c.id);
      return show(i, c, `✅ Message enregistré. ${counts.total} destinataire(s). Vérifie l’aperçu ci-dessous, fais un test, puis envoie.`);
    }
    case 'refresh': {
      await i.deferUpdate();
      const { added } = await refreshRecipients(c.id);
      return show(i, c, added ? `🔄 ${added} nouveau(x) membre(s) ajouté(s)${c.with_keys ? ' avec leur clé' : ''}.` : '🔄 Aucun nouveau membre avec ce rôle.');
    }
    case 'test': {
      await deferEphemeral(i);
      try {
        await i.user.send({ embeds: [dmEmbed(c, { userId: i.user.id, displayName: i.member.displayName, key: c.with_keys ? 'RBKS-TEST-TEST-TEST' : null, roblox: recipients.robloxOf(i.user.id) })] });
        return ephemeral(i, successEmbed('Message de test envoyé dans tes MP (avec une fausse clé).'));
      } catch {
        return fail(i, 'Impossible de t’envoyer le test : tes messages privés sont fermés.');
      }
    }
    case 'send': {
      if (!i.isButton()) return;
      const n = campaigns.counts(c.id);
      return i.update({
        embeds: [warnEmbed(`Le message va être envoyé en privé à **${n.pending} membre(s)**${c.with_keys ? ', chacun avec sa clé' : ''}.\nDurée estimée : ~${formatDuration(n.pending * SEND_DELAY_MS + 6e4)}. Tu peux fermer Discord pendant l’envoi.`, 'Confirmer l’envoi')],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(cid(P, 'confirm', c.id)).setLabel('Confirmer l’envoi').setEmoji('📨').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(cid(P, 'back', c.id)).setLabel('Retour').setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    }
    case 'back':
      return show(i, c);
    case 'retry': {
      const n = recipients.retryFailed(c.id);
      return show(i, c, `🔁 ${n} échec(s) remis en attente. Clique sur « Envoyer » pour réessayer (pense à demander aux membres d’ouvrir leurs MP).`);
    }
    case 'confirm': {
      if (!i.isButton()) return;
      if (isRunning(c.id)) return fail(i, 'Un envoi est déjà en cours pour ce lot.');
      if (!c.message.trim()) return fail(i, 'Le message est vide.');
      const total = campaigns.counts(c.id).pending;
      await i.update({ embeds: [infoEmbed(`📨 Envoi en cours… 0 / ${total}`)], components: [] });
      await audit({ type: 'admin', action: 'massdm_start', actorId: i.user.id, target: c.name, message: `Envoi groupé « ${c.name} » lancé vers ${total} membre(s) du rôle <@&${c.role_id}>.` });
      const started = Date.now();
      // L'envoi continue en arrière-plan ; la fenêtre est mise à jour tant que Discord le permet (15 min).
      void runCampaign(c.id, (n) => i.editReply({ embeds: [infoEmbed(`📨 Envoi en cours… ${n.sent + n.failed} / ${n.total} (${n.failed} échec(s))`)] }).then(() => undefined))
        .then(async (n) => {
          if (!n) return;
          await i
            .editReply({
              embeds: [
                brandEmbed({
                  title: `✅ Envoi « ${c.name} » terminé`,
                  description: `📬 Reçus : **${n.sent}**\n❌ Échecs : **${n.failed}**${n.failed ? ' (MP fermés ou membre parti — ils peuvent retrouver leur clé avec `/macle`)' : ''}\n⏱️ Durée : ${formatDuration(Date.now() - started)}`,
                  color: n.failed ? COLORS.warning : COLORS.success,
                }),
              ],
              components: panel(campaigns.get(c.id)!, { id: i.user.id, displayName: i.member.displayName }).components,
            })
            .catch(() => undefined);
        })
        .catch((e) => i.editReply({ embeds: [warnEmbed(`Envoi interrompu : ${(e as Error).message}. Relance-le avec /massdm open.`)] }).catch(() => undefined));
      return;
    }
    case 'export': {
      await deferEphemeral(i);
      const n = campaigns.counts(c.id);
      await audit({ type: 'admin', action: 'massdm_export', actorId: i.user.id, target: c.name, message: `Export des clés du lot « ${c.name} » (${n.total} clé(s)).` });
      return ephemeral(i, {
        embeds: [
          infoEmbed(
            `**${n.total} clé(s)** du lot « ${c.name} ».\n\n• \`.lua\` : à coller dans un **ModuleScript de ServerStorage** dans Roblox Studio (jamais côté client). Côté serveur : \`local Keys = require(ServerStorage.RBKSAccessKeys)\` puis \`if Keys[cleSaisie] then … end\`.\n• \`.csv\` : ouvrable dans Excel.\n• \`.json\` : pour un outil ou un serveur externe.\n\n⚠️ Ces fichiers contiennent les clés : ne les partage pas.`,
            'Export des clés',
          ),
        ],
        files: exportFiles(c),
      });
    }
    case 'delete': {
      if (!i.isButton()) return;
      return i.update({
        embeds: [warnEmbed(`Supprimer le lot « ${c.name} » ? ${c.with_keys ? 'Ses clés seront effacées du bot (`/macle` ne les affichera plus). Pense à les retirer aussi du jeu.' : ''}`, 'Confirmer la suppression')],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(cid(P, 'deleteok', c.id)).setLabel('Supprimer définitivement').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(cid(P, 'back', c.id)).setLabel('Retour').setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    }
    case 'deleteok': {
      if (!i.isButton()) return;
      if (isRunning(c.id)) return fail(i, 'Envoi en cours : attends la fin.');
      campaigns.remove(c.id);
      await audit({ type: 'admin', action: 'massdm_delete', actorId: i.user.id, target: c.name, message: `Lot d’envoi « ${c.name} » supprimé.` });
      return i.update({ embeds: [successEmbed(`Lot « ${c.name} » supprimé.`)], components: [] });
    }
  }
}

async function campaignAutocomplete(i: AutocompleteInteraction<'cached'>) {
  await i.respond(
    campaigns.search(String(i.options.getFocused())).map((c) => {
      const n = campaigns.counts(c.id);
      return { name: truncate(`${c.name} — ${STATUS_LABEL[c.status]} (${n.sent}/${n.total})`, 100), value: c.name };
    }),
  );
}

const lotOption = (o: any) => o.setName('lot').setDescription('Nom du lot').setRequired(true).setAutocomplete(true);

export const massdmModule: BotModule = {
  name: 'massdm',
  components: [{ prefix: P, handle }],
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('massdm')
        .setDescription('Messages privés groupés (avec clés d’accès au jeu)')
        .addSubcommand((s) =>
          s
            .setName('create')
            .setDescription('Préparer un message privé pour tous les membres d’un rôle')
            .addStringOption((o) => o.setName('nom').setDescription('Nom du lot, ex. beta-1').setRequired(true).setMaxLength(40))
            .addRoleOption((o) => o.setName('role').setDescription('Destinataires (par défaut : 🧪 Testeur)'))
            .addBooleanOption((o) => o.setName('cles').setDescription('Donner une clé d’accès unique à chaque membre (par défaut : oui)')),
        )
        .addSubcommand((s) => s.setName('open').setDescription('Ouvrir un lot : aperçu, test, envoi, export').addStringOption(lotOption))
        .addSubcommand((s) => s.setName('export').setDescription('Exporter les clés d’un lot (fichier Roblox .lua, .csv, .json)').addStringOption(lotOption))
        .addSubcommand((s) => s.setName('list').setDescription('Lister les lots')),
      feature: 'massdm.manage',
      category: '📢 Publications',
      help: [
        { usage: '/massdm create <nom> [role] [cles]', description: 'Préparer un MP groupé avec clés d’accès', feature: 'massdm.manage' },
        { usage: '/massdm open|export|list', description: 'Envoyer, relancer, exporter les clés pour Roblox', feature: 'massdm.manage' },
      ],
      autocomplete: campaignAutocomplete,
      async execute(i) {
        const sub = i.options.getSubcommand();
        if (sub === 'list') {
          const list = campaigns.list();
          const e = brandEmbed({ title: '📨 Envois groupés', description: list.length ? undefined : 'Aucun lot. Crée-en un avec `/massdm create`.' });
          for (const c of list.slice(0, 25)) {
            const n = campaigns.counts(c.id);
            e.addFields({ name: `${c.name} — ${STATUS_LABEL[c.status]}`, value: `<@&${c.role_id}> • ${n.sent}/${n.total} reçu(s), ${n.failed} échec(s)${c.with_keys ? ' • 🔑 clés' : ''} • créé ${discordTs(c.created_at, 'R')}` });
          }
          return ephemeral(i, e);
        }
        if (sub === 'create') {
          const name = i.options.getString('nom', true).trim();
          if (campaigns.byName(name)) return fail(i, `Le lot « ${name} » existe déjà : ouvre-le avec \`/massdm open\`.`);
          const role = i.options.getRole('role') ?? (managedRole('tester') ? i.guild.roles.cache.get(managedRole('tester')!) : null);
          if (!role) return fail(i, 'Choisis le rôle des destinataires (option « role »).');
          if (role.id === i.guild.id) return fail(i, 'Envoyer un MP à tout le serveur (@everyone) n’est pas autorisé : choisis un rôle précis.');
          const id = campaigns.create({ name, roleId: role.id, withKeys: i.options.getBoolean('cles') ?? true, createdBy: i.user.id });
          return openModal(i, messageModal(campaigns.get(id)!));
        }
        const c = campaigns.byName(i.options.getString('lot', true));
        if (!c) return fail(i, 'Lot introuvable.');
        if (sub === 'export') {
          if (!c.with_keys) return fail(i, 'Ce lot ne contient pas de clés.');
          await deferEphemeral(i);
          await refreshRecipients(c.id).catch(() => undefined);
          await audit({ type: 'admin', action: 'massdm_export', actorId: i.user.id, target: c.name, message: `Export des clés du lot « ${c.name} ».` });
          return ephemeral(i, { embeds: [infoEmbed(`Clés du lot « ${c.name} ». Le fichier \`.lua\` se colle dans un ModuleScript de **ServerStorage** dans Roblox Studio.`)], files: exportFiles(c) });
        }
        await deferEphemeral(i);
        await refreshRecipients(c.id).catch(() => undefined);
        return i.editReply(panel(campaigns.get(c.id)!, { id: i.user.id, displayName: i.member.displayName }));
      },
    },
    {
      data: new SlashCommandBuilder().setName('macle').setDescription('Retrouver ta clé d’accès au jeu (en privé)'),
      category: '💬 Communauté',
      help: [{ usage: '/macle', description: 'Retrouver ta clé d’accès au jeu' }],
      async execute(i) {
        const keys = recipients.keysForUser(i.user.id);
        if (!keys.length) return ephemeral(i, infoEmbed('Tu n’as pas encore de clé d’accès. Elles sont envoyées aux membres acceptés pour les phases de test.'));
        const e = brandEmbed({ title: '🔑 Tes clés d’accès', description: 'Elles sont **personnelles** : ne les partage avec personne.' });
        for (const k of keys.slice(0, 10)) e.addFields({ name: k.campaign_title || k.campaign_name, value: `\`\`\`\n${k.access_key}\n\`\`\`` });
        return ephemeral(i, e);
      },
    },
  ],
};
