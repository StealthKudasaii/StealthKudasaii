/** Libellés, emojis et couleurs partagés entre Discord et le panel web. */

export interface StatusMeta {
  label: string;
  emoji: string;
  color: number;
}

type StatusMap<K extends string> = Record<K, StatusMeta>;

export const COLORS = {
  brand: 0xff4d2e,
  success: 0x2ecc71,
  danger: 0xe74c3c,
  warning: 0xf1c40f,
  info: 0x3ba7ff,
  muted: 0x5c6370,
  dark: 0x16181d,
} as const;

/** Éléments et styles de combat du jeu (utilisés pour les catégories et le style visuel). */
export const ELEMENTS = [
  { key: 'katon', label: 'Katon', emoji: '🔥', color: 0xff5a1f },
  { key: 'raiton', label: 'Raiton', emoji: '⚡', color: 0xffd43b },
  { key: 'doton', label: 'Doton', emoji: '🪨', color: 0xa0703c },
  { key: 'futon', label: 'Fūton', emoji: '🌪️', color: 0x7bd389 },
  { key: 'suiton', label: 'Suiton', emoji: '🌊', color: 0x3ba7ff },
  { key: 'taijutsu', label: 'Taijutsu', emoji: '👊', color: 0xe64980 },
  { key: 'kenjutsu', label: 'Kenjutsu', emoji: '🗡️', color: 0xc0c7d1 },
] as const;

export const VERSION_STATUS = {
  planned: { label: 'Planifiée', emoji: '🗓️', color: COLORS.muted },
  in_progress: { label: 'En développement', emoji: '🛠️', color: COLORS.info },
  testing: { label: 'En test', emoji: '🧪', color: COLORS.warning },
  released: { label: 'Sortie', emoji: '🚀', color: COLORS.success },
  postponed: { label: 'Reportée', emoji: '⏸️', color: COLORS.danger },
} satisfies StatusMap<string>;
export type VersionStatus = keyof typeof VERSION_STATUS;

export const TASK_STATUS = {
  todo: { label: 'À faire', emoji: '📝', color: COLORS.muted },
  in_progress: { label: 'En cours', emoji: '🔨', color: COLORS.info },
  testing: { label: 'En test', emoji: '🧪', color: COLORS.warning },
  done: { label: 'Terminé', emoji: '✅', color: COLORS.success },
  postponed: { label: 'Reporté', emoji: '⏸️', color: COLORS.danger },
} satisfies StatusMap<string>;
export type TaskStatus = keyof typeof TASK_STATUS;

export const TASK_PRIORITY = {
  low: { label: 'Basse', emoji: '🟢', color: COLORS.success },
  medium: { label: 'Moyenne', emoji: '🟡', color: COLORS.warning },
  high: { label: 'Haute', emoji: '🟠', color: 0xff8c1a },
  critical: { label: 'Critique', emoji: '🔴', color: COLORS.danger },
} satisfies StatusMap<string>;
export type TaskPriority = keyof typeof TASK_PRIORITY;

export const TASK_CATEGORIES = ['Gameplay', 'Combat', 'Techniques', 'Interface', 'Map', 'VFX / Animations', 'Système', 'Audio', 'Optimisation', 'Général'];

export const ROADMAP_STATUS = {
  upcoming: { label: 'À venir', emoji: '🌑', color: COLORS.muted },
  planned: { label: 'Planifié', emoji: '🗓️', color: 0x8e9bff },
  in_progress: { label: 'En développement', emoji: '🛠️', color: COLORS.info },
  testing: { label: 'En test', emoji: '🧪', color: COLORS.warning },
  done: { label: 'Terminé', emoji: '✅', color: COLORS.success },
  postponed: { label: 'Reporté', emoji: '⏸️', color: COLORS.danger },
} satisfies StatusMap<string>;
export type RoadmapStatus = keyof typeof ROADMAP_STATUS;

export const ROADMAP_DEFAULT_CATEGORIES: { name: string; emoji: string }[] = [
  { name: 'Combat System', emoji: '⚔️' },
  { name: 'Techniques & Éléments', emoji: '🔥' },
  { name: 'Maps & Environnements', emoji: '🗺️' },
  { name: 'Animations & VFX', emoji: '✨' },
  { name: 'Interface & HUD', emoji: '🖥️' },
  { name: 'Systèmes de jeu', emoji: '⚙️' },
  { name: 'Optimisation', emoji: '🚀' },
  { name: 'Release & Beta', emoji: '🧪' },
];

export const SUGGESTION_STATUS = {
  pending: { label: 'En attente', emoji: '⏳', color: COLORS.muted },
  accepted: { label: 'Acceptée', emoji: '✅', color: COLORS.success },
  refused: { label: 'Refusée', emoji: '❌', color: COLORS.danger },
  in_progress: { label: 'En développement', emoji: '🛠️', color: COLORS.info },
  implemented: { label: 'Implémentée', emoji: '🚀', color: 0x9b59b6 },
} satisfies StatusMap<string>;
export type SuggestionStatus = keyof typeof SUGGESTION_STATUS;

export const BUG_STATUS = {
  new: { label: 'Nouveau', emoji: '🆕', color: COLORS.danger },
  acknowledged: { label: 'Pris en charge', emoji: '🙋', color: 0xff8c1a },
  in_progress: { label: 'En cours de correction', emoji: '🛠️', color: COLORS.info },
  resolved: { label: 'Résolu', emoji: '✅', color: COLORS.success },
  not_reproducible: { label: 'Non reproductible', emoji: '❔', color: COLORS.muted },
  closed: { label: 'Fermé', emoji: '🔒', color: COLORS.muted },
} satisfies StatusMap<string>;
export type BugStatus = keyof typeof BUG_STATUS;

export const PLATFORMS = ['PC', 'Mobile', 'Tablette', 'Console', 'Autre'];

export const APPLICATION_STATUS = {
  pending: { label: 'En attente d’examen', emoji: '⏳', color: COLORS.info },
  on_hold: { label: 'Mise en attente', emoji: '⏸️', color: COLORS.warning },
  accepted: { label: 'Acceptée', emoji: '✅', color: COLORS.success },
  refused: { label: 'Refusée', emoji: '❌', color: COLORS.danger },
} satisfies StatusMap<string>;
export type ApplicationStatus = keyof typeof APPLICATION_STATUS;

export const TICKET_STATUS = {
  open: { label: 'Ouvert', emoji: '🟢', color: COLORS.success },
  claimed: { label: 'Pris en charge', emoji: '🙋', color: COLORS.info },
  closed: { label: 'Fermé', emoji: '🔒', color: COLORS.muted },
} satisfies StatusMap<string>;
export type TicketStatus = keyof typeof TICKET_STATUS;

export const TICKET_DEFAULT_REASONS = [
  { label: 'Question générale', emoji: '❓', description: 'Une question sur le jeu ou le serveur' },
  { label: 'Problème en jeu', emoji: '🎮', description: 'Bug bloquant, progression, objet perdu…' },
  { label: 'Problème technique', emoji: '🛠️', description: 'Crash, connexion, performances' },
  { label: 'Bêta-test', emoji: '🧪', description: 'Candidature ou question sur la bêta' },
  { label: 'Signalement d’un joueur', emoji: '🚨', description: 'Triche, comportement toxique…' },
  { label: 'Autre demande', emoji: '📩', description: 'Tout le reste' },
];

export const SESSION_STATUS = {
  scheduled: { label: 'Inscriptions ouvertes', emoji: '📅', color: COLORS.info },
  live: { label: 'En cours', emoji: '🔴', color: COLORS.danger },
  ended: { label: 'Terminée', emoji: '🏁', color: COLORS.muted },
  cancelled: { label: 'Annulée', emoji: '🚫', color: COLORS.muted },
} satisfies StatusMap<string>;

export const QUESTION_TYPES = {
  short: { label: 'Réponse courte', emoji: '✏️' },
  long: { label: 'Réponse longue', emoji: '📝' },
  single: { label: 'Choix unique', emoji: '🔘' },
  multi: { label: 'Choix multiple', emoji: '☑️' },
  number: { label: 'Nombre', emoji: '🔢' },
  roblox: { label: 'Pseudo Roblox', emoji: '🎮' },
} as const;
export type QuestionType = keyof typeof QUESTION_TYPES;

export const PUBLICATION_KINDS = {
  patchnote: { label: 'Patch note', emoji: '🧾', channel: 'patchnotes', notif: 'patchnotes' },
  announcement: { label: 'Annonce', emoji: '📢', channel: 'announcements', notif: 'announcements' },
  update: { label: 'Mise à jour', emoji: '⬆️', channel: 'updates', notif: 'updates' },
  spoil: { label: 'Spoil', emoji: '👀', channel: 'spoil', notif: 'announcements' },
} as const;
export type PublicationKind = keyof typeof PUBLICATION_KINDS;

export function statusOptions<T extends Record<string, StatusMeta>>(map: T) {
  return Object.entries(map).map(([value, m]) => ({ name: `${m.emoji} ${m.label}`, value }));
}

export function isKeyOf<T extends object>(map: T, key: unknown): key is keyof T {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key);
}
