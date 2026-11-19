import { ChannelType, PermissionFlagsBits as P } from 'discord.js';

/**
 * Structure cible du serveur RBKS PVP, utilisée par /setup.
 * Chaque élément a une clé stable : c'est elle (et non le nom) qui permet au bot
 * de reconnaître ses éléments même s'ils sont renommés.
 */

export type RoleKey =
  | 'founder'
  | 'cofounder'
  | 'admin'
  | 'moderator'
  | 'support'
  | 'developer'
  | 'builder'
  | 'tester'
  | 'vip'
  | 'member'
  | 'bots'
  | 'notif_announcements'
  | 'notif_updates'
  | 'notif_patchnotes'
  | 'notif_beta'
  | 'notif_sessions';

export interface RoleSpec {
  key: RoleKey;
  name: string;
  /** Anciennes appellations reconnues lors de la détection. */
  aliases?: string[];
  color: number;
  hoist: boolean;
  mentionable: boolean;
  permissions: bigint[];
  group: 'Administration' | 'Développement' | 'Communauté' | 'Notifications';
}

/** Ordre = hiérarchie (du plus haut au plus bas). */
export const ROLE_SPECS: RoleSpec[] = [
  { key: 'founder', name: '👑 Fondateur', color: 0xf5c518, hoist: true, mentionable: false, permissions: [P.Administrator], group: 'Administration' },
  {
    key: 'cofounder',
    name: '⚜️ Co-Fondateur',
    color: 0xff8c1a,
    hoist: true,
    mentionable: false,
    group: 'Administration',
    permissions: [
      P.ManageGuild, P.ManageChannels, P.ManageRoles, P.KickMembers, P.BanMembers, P.ModerateMembers,
      P.ManageMessages, P.ManageNicknames, P.ManageThreads, P.MentionEveryone, P.ViewAuditLog,
      P.MoveMembers, P.MuteMembers, P.DeafenMembers, P.ManageEvents, P.ManageGuildExpressions,
    ],
  },
  {
    key: 'admin',
    name: '🛡️ Administrateur',
    color: 0xe74c3c,
    hoist: true,
    mentionable: false,
    group: 'Administration',
    permissions: [
      P.ManageChannels, P.KickMembers, P.BanMembers, P.ModerateMembers, P.ManageMessages, P.ManageNicknames,
      P.ManageThreads, P.ViewAuditLog, P.MoveMembers, P.MuteMembers, P.MentionEveryone, P.ManageEvents,
    ],
  },
  {
    key: 'moderator',
    name: '🔨 Modérateur',
    color: 0x3498db,
    hoist: true,
    mentionable: false,
    group: 'Administration',
    permissions: [P.ManageMessages, P.KickMembers, P.BanMembers, P.ModerateMembers, P.ManageNicknames, P.ManageThreads, P.MuteMembers, P.MoveMembers],
  },
  { key: 'support', name: '🎫 Support', color: 0x1abc9c, hoist: true, mentionable: false, permissions: [], group: 'Administration' },
  { key: 'developer', name: '💻 Développeur', color: 0x9b59b6, hoist: true, mentionable: false, permissions: [], group: 'Développement' },
  { key: 'builder', name: '🎨 Builder', color: 0xe91e63, hoist: true, mentionable: false, permissions: [], group: 'Développement' },
  { key: 'tester', name: '🧪 Testeur', color: 0x2ecc71, hoist: true, mentionable: false, permissions: [], group: 'Développement' },
  { key: 'vip', name: '⭐ VIP', color: 0xffd43b, hoist: true, mentionable: false, permissions: [], group: 'Communauté' },
  { key: 'member', name: '👤 Membre', color: 0x95a5a6, hoist: false, mentionable: false, permissions: [], group: 'Communauté' },
  { key: 'bots', name: '🤖 Bots', color: 0x5865f2, hoist: false, mentionable: false, permissions: [], group: 'Communauté' },
  { key: 'notif_announcements', name: '🔔 Annonces', color: 0, hoist: false, mentionable: false, permissions: [], group: 'Notifications' },
  { key: 'notif_updates', name: '🔔 Mises à jour', color: 0, hoist: false, mentionable: false, permissions: [], group: 'Notifications' },
  { key: 'notif_patchnotes', name: '🔔 Patch notes', color: 0, hoist: false, mentionable: false, permissions: [], group: 'Notifications' },
  { key: 'notif_beta', name: '🔔 Bêta-tests', color: 0, hoist: false, mentionable: false, permissions: [], group: 'Notifications' },
  { key: 'notif_sessions', name: '🔔 Sessions de test', color: 0, hoist: false, mentionable: false, permissions: [], group: 'Notifications' },
];

export const NOTIFICATION_TYPES: { key: string; role: RoleKey; label: string; emoji: string; description: string }[] = [
  { key: 'announcements', role: 'notif_announcements', label: 'Annonces importantes', emoji: '📢', description: 'Les grandes nouvelles de RBKS PVP' },
  { key: 'updates', role: 'notif_updates', label: 'Mises à jour', emoji: '⬆️', description: 'Chaque nouvelle mise à jour du jeu' },
  { key: 'patchnotes', role: 'notif_patchnotes', label: 'Patch notes', emoji: '🧾', description: 'Le détail des correctifs et équilibrages' },
  { key: 'beta', role: 'notif_beta', label: 'Bêta-tests', emoji: '🧪', description: 'Ouverture des candidatures et phases bêta' },
  { key: 'sessions', role: 'notif_sessions', label: 'Sessions de test', emoji: '🎮', description: 'Les sessions de test planifiées' },
];

/** Groupes de rôles réutilisés dans les permissions de salons. */
export const STAFF_HIGH: RoleKey[] = ['founder', 'cofounder', 'admin'];
export const STAFF_ALL: RoleKey[] = ['founder', 'cofounder', 'admin', 'moderator', 'support'];
export const DEV_TEAM: RoleKey[] = ['developer', 'builder'];

export type ChannelPreset =
  | 'public_readonly' // tout le monde lit, seul le staff écrit
  | 'public_readonly_threads' // idem + discussion dans les fils
  | 'testers_readonly' // testeurs + équipe + staff lisent, seul le staff écrit
  | 'testers_chat' // testeurs + équipe + staff discutent
  | 'dev_chat' // équipe de dev + staff
  | 'testers_voice'
  | 'staff_private' // fondateurs + admins
  | 'tickets_category'; // catégorie privée des tickets

export type ChannelKey =
  | 'welcome'
  | 'announcements'
  | 'rules'
  | 'notifications'
  | 'updates'
  | 'patchnotes'
  | 'spoil'
  | 'release'
  | 'todo'
  | 'suggestions'
  | 'bugs'
  | 'testers'
  | 'resources'
  | 'test_voice'
  | 'open_ticket'
  | 'logs'
  | 'applications';

export type CategoryKey = 'cat_info' | 'cat_dev' | 'cat_support' | 'cat_tickets' | 'cat_staff';

export interface ChannelSpec {
  key: ChannelKey;
  name: string;
  aliases?: string[];
  type: ChannelType.GuildText | ChannelType.GuildVoice;
  preset: ChannelPreset;
  topic?: string;
}

export interface CategorySpec {
  key: CategoryKey;
  name: string;
  aliases?: string[];
  preset?: ChannelPreset;
  channels: ChannelSpec[];
}

const T = ChannelType.GuildText as const;
const V = ChannelType.GuildVoice as const;

export const CATEGORY_SPECS: CategorySpec[] = [
  {
    key: 'cat_info',
    name: '📌 RBKS PVP',
    channels: [
      { key: 'welcome', name: 'bienvenue', type: T, preset: 'public_readonly', topic: 'Les nouveaux membres de RBKS PVP' },
      { key: 'announcements', name: 'annonces', type: T, preset: 'public_readonly', topic: 'Annonces officielles de RBKS PVP' },
      { key: 'rules', name: 'règlement', aliases: ['reglement', 'rules'], type: T, preset: 'public_readonly', topic: 'Règlement du serveur' },
      { key: 'notifications', name: 'notifications', type: T, preset: 'public_readonly', topic: 'Choisis les notifications que tu veux recevoir' },
      { key: 'updates', name: 'mises-à-jour', aliases: ['mises-a-jour', 'updates'], type: T, preset: 'public_readonly', topic: 'Les mises à jour du jeu' },
      { key: 'patchnotes', name: 'patch-note', aliases: ['patch-notes', 'patchnote'], type: T, preset: 'public_readonly', topic: 'Détail des correctifs et équilibrages' },
      { key: 'spoil', name: 'spoil', aliases: ['spoils'], type: T, preset: 'public_readonly', topic: 'Aperçus du contenu à venir' },
    ],
  },
  {
    key: 'cat_dev',
    name: '🧪 DÉVELOPPEMENT',
    aliases: ['developpement'],
    channels: [
      { key: 'release', name: 'release', aliases: ['releases'], type: T, preset: 'public_readonly', topic: 'Versions du jeu et roadmap' },
      { key: 'todo', name: 'to-do', aliases: ['todo'], type: T, preset: 'public_readonly', topic: 'Suivi des tâches de développement' },
      { key: 'suggestions', name: 'suggestions', type: T, preset: 'public_readonly_threads', topic: 'Propose tes idées avec /suggestion' },
      { key: 'bugs', name: 'bugs', type: T, preset: 'testers_readonly', topic: 'Signalements de bugs — utilise /bugreport' },
      { key: 'testers', name: 'testeurs', aliases: ['testers'], type: T, preset: 'testers_chat', topic: 'Espace des testeurs' },
      { key: 'resources', name: 'ressources', aliases: ['resources'], type: T, preset: 'dev_chat', topic: 'Ressources de l’équipe de développement' },
      { key: 'test_voice', name: 'Session de test', type: V, preset: 'testers_voice' },
    ],
  },
  {
    key: 'cat_support',
    name: '🎫 SUPPORT',
    channels: [{ key: 'open_ticket', name: 'ouvrir-un-ticket', type: T, preset: 'public_readonly', topic: 'Ouvre un ticket pour contacter le staff' }],
  },
  { key: 'cat_tickets', name: '🎟️ TICKETS', preset: 'tickets_category', channels: [] },
  {
    key: 'cat_staff',
    name: '🔒 STAFF',
    preset: 'staff_private',
    channels: [
      { key: 'logs', name: 'logs-bot', type: T, preset: 'staff_private', topic: 'Journal des actions du bot' },
      { key: 'applications', name: 'candidatures', type: T, preset: 'staff_private', topic: 'Candidatures bêta-test à examiner' },
    ],
  },
];

export interface OverwriteSpec {
  target: RoleKey | '@everyone' | '@bot';
  allow: bigint[];
  deny: bigint[];
}

const READ = [P.ViewChannel, P.ReadMessageHistory];
const WRITE = [P.SendMessages, P.SendMessagesInThreads, P.EmbedLinks, P.AttachFiles, P.AddReactions];
const NO_WRITE = [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads];
const BOT = [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ManageMessages, P.ManageThreads, P.CreatePublicThreads, P.SendMessagesInThreads];

const allow = (targets: RoleKey[], perms: bigint[]): OverwriteSpec[] => targets.map((t) => ({ target: t, allow: perms, deny: [] }));

/** Permissions de salon par preset. Le Fondateur (Administrateur) voit tout de toute façon. */
export function presetOverwrites(preset: ChannelPreset): OverwriteSpec[] {
  switch (preset) {
    case 'public_readonly':
      return [
        { target: '@everyone', allow: [...READ, P.AddReactions], deny: NO_WRITE },
        ...allow(STAFF_HIGH, [...READ, ...WRITE]),
        { target: '@bot', allow: BOT, deny: [] },
      ];
    case 'public_readonly_threads':
      return [
        { target: '@everyone', allow: [...READ, P.AddReactions, P.SendMessagesInThreads], deny: NO_WRITE },
        ...allow(STAFF_HIGH, [...READ, ...WRITE]),
        { target: '@bot', allow: BOT, deny: [] },
      ];
    case 'testers_readonly':
      return [
        { target: '@everyone', allow: [], deny: [P.ViewChannel] },
        ...allow(['tester', ...DEV_TEAM, 'moderator', 'support'], [...READ, P.AddReactions]),
        ...allow(STAFF_HIGH, [...READ, ...WRITE]),
        { target: '@bot', allow: BOT, deny: [] },
      ];
    case 'testers_chat':
      return [
        { target: '@everyone', allow: [], deny: [P.ViewChannel] },
        ...allow(['tester', ...DEV_TEAM, ...STAFF_HIGH], [...READ, ...WRITE]),
        { target: '@bot', allow: BOT, deny: [] },
      ];
    case 'dev_chat':
      return [
        { target: '@everyone', allow: [], deny: [P.ViewChannel] },
        ...allow([...DEV_TEAM, ...STAFF_HIGH], [...READ, ...WRITE]),
        { target: '@bot', allow: BOT, deny: [] },
      ];
    case 'testers_voice':
      return [
        { target: '@everyone', allow: [], deny: [P.ViewChannel] },
        ...allow(['tester', ...DEV_TEAM, ...STAFF_HIGH], [P.ViewChannel, P.Connect, P.Speak, P.Stream, P.UseVAD]),
        { target: '@bot', allow: [P.ViewChannel, P.Connect], deny: [] },
      ];
    case 'staff_private':
      return [
        { target: '@everyone', allow: [], deny: [P.ViewChannel] },
        ...allow(STAFF_HIGH, [...READ, ...WRITE]),
        { target: '@bot', allow: BOT, deny: [] },
      ];
    case 'tickets_category':
      return [
        { target: '@everyone', allow: [], deny: [P.ViewChannel] },
        { target: '@bot', allow: [...BOT, P.ManageChannels], deny: [] },
      ];
  }
}

/** Permissions minimales demandées lors de l'invitation du bot (pas Administrateur). */
export const BOT_INVITE_PERMISSIONS: bigint[] = [
  P.ManageRoles, P.ManageChannels, P.ManageGuild, P.ManageGuildExpressions, P.ManageEvents, P.ViewAuditLog,
  P.KickMembers, P.BanMembers, P.ModerateMembers, P.ManageNicknames, P.ChangeNickname,
  P.ViewChannel, P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads, P.CreatePrivateThreads, P.ManageThreads,
  P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory, P.AddReactions, P.UseExternalEmojis, P.ManageMessages, P.MentionEveryone,
  P.Connect, P.Speak, P.Stream, P.UseVAD, P.MoveMembers, P.MuteMembers, P.DeafenMembers,
];

export function allChannelSpecs(): (ChannelSpec & { category: CategoryKey })[] {
  return CATEGORY_SPECS.flatMap((c) => c.channels.map((ch) => ({ ...ch, category: c.key })));
}
