import { db } from '../../db';

/** Ce que mesure un défi. Les valeurs sont calculées à partir des données déjà suivies par le bot. */
export const METRICS = {
  linked: { label: 'Compte Roblox relié', unit: '', emoji: '🔗', help: 'Relier son compte Roblox (seuil : 1)' },
  invites: { label: 'Invitations', unit: 'invitation(s)', emoji: '📨', help: 'Amis invités encore présents sur le serveur' },
  beta: { label: 'Bêta acceptée', unit: '', emoji: '🧪', help: 'Candidature bêta acceptée ou rôle Testeur (seuil : 1)' },
  test_sessions: { label: 'Sessions de test', unit: 'session(s)', emoji: '🎮', help: 'Sessions de test terminées auxquelles le membre était inscrit' },
  bugs_resolved: { label: 'Bugs corrigés', unit: 'bug(s)', emoji: '🐞', help: 'Bugs signalés puis marqués « Résolu »' },
  suggestions_accepted: { label: 'Suggestions retenues', unit: 'suggestion(s)', emoji: '💡', help: 'Suggestions acceptées, en développement ou implémentées' },
  boost: { label: 'Boost du serveur', unit: '', emoji: '💎', help: 'Booster le serveur Discord (seuil : 1)' },
  voice_minutes: { label: 'Temps en vocal', unit: 'min', emoji: '🎙️', help: 'Minutes en vocal avec au moins une autre personne, sans être en sourdine casque, hors salon AFK' },
  messages: { label: 'Messages', unit: 'message(s)', emoji: '💬', help: 'Messages d’au moins 3 caractères, au plus 1 compté toutes les 15 secondes' },
  polls: { label: 'Sondages', unit: 'sondage(s)', emoji: '🗳️', help: 'Sondages auxquels le membre a voté' },
  announcement_reactions: { label: 'Réactions aux annonces', unit: 'annonce(s)', emoji: '📢', help: 'Annonces/mises à jour/patch notes avec une réaction dans l’heure suivant leur publication (1 par annonce)' },
} as const;
export type Metric = keyof typeof METRICS;
export const isMetric = (m: string): m is Metric => Object.prototype.hasOwnProperty.call(METRICS, m);

export interface Challenge {
  id: number;
  title: string;
  description: string;
  metric: Metric;
  threshold: number;
  reward_id: string;
  reward_label: string;
  emoji: string | null;
  position: number;
  enabled: number;
}

export interface RobloxLink {
  discord_id: string;
  roblox_id: string;
  roblox_username: string;
  roblox_display_name: string | null;
  linked_at: number;
  needs_sync: number;
  synced_at: number | null;
  sync_error: string | null;
}

export type ChallengeInput = Omit<Challenge, 'id' | 'enabled'> & { enabled: boolean };

/** Mesures « oui/non » : le seuil est toujours 1. */
export const BINARY_METRICS: Metric[] = ['linked', 'beta', 'boost'];

/** Identifiant de récompense lisible par le script du jeu, déduit du nom (« Titre Genin » → titre_genin). */
export function slugifyRewardId(label: string): string {
  return (
    label
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 50) || 'recompense'
  );
}

/** Valide un défi saisi (commande Discord ou panel). */
export function parseChallenge(raw: {
  metric: string;
  title: string;
  rewardLabel: string;
  rewardId?: string;
  threshold?: string | number | null;
  description?: string;
  emoji?: string | null;
  position?: number;
  enabled?: boolean;
}): { ok: true; value: ChallengeInput } | { ok: false; error: string } {
  if (!isMetric(raw.metric)) return { ok: false, error: 'Type de défi inconnu.' };
  const title = raw.title.trim();
  const rewardLabel = raw.rewardLabel.trim();
  if (!title) return { ok: false, error: 'Le nom du défi est obligatoire.' };
  if (!rewardLabel) return { ok: false, error: 'La récompense est obligatoire.' };
  if (title.length > 100 || rewardLabel.length > 100) return { ok: false, error: 'Nom du défi et récompense : 100 caractères maximum.' };
  const rewardId = (raw.rewardId ?? '').trim() || slugifyRewardId(rewardLabel);
  if (!/^[A-Za-z0-9_.-]{1,50}$/.test(rewardId)) {
    return { ok: false, error: 'Identifiant pour le jeu invalide : lettres, chiffres, « _ », « - » ou « . » uniquement (c’est la clé utilisée dans le script Roblox). Laisse vide pour le générer.' };
  }
  let threshold = 1;
  if (!BINARY_METRICS.includes(raw.metric)) {
    const n = Number(String(raw.threshold ?? '').replace(/\s/g, ''));
    if (!Number.isInteger(n) || n < 1 || n > 1_000_000) return { ok: false, error: 'L’objectif doit être un nombre entier entre 1 et 1 000 000.' };
    threshold = n;
  }
  return {
    ok: true,
    value: {
      title,
      description: (raw.description ?? '').trim().slice(0, 200),
      metric: raw.metric,
      threshold,
      reward_id: rewardId,
      reward_label: rewardLabel,
      emoji: raw.emoji?.trim() || null,
      position: raw.position ?? 0,
      enabled: raw.enabled ?? true,
    },
  };
}

export const challenges = {
  list(onlyEnabled = false): Challenge[] {
    return db().prepare(`SELECT * FROM reward_challenges ${onlyEnabled ? 'WHERE enabled = 1' : ''} ORDER BY position, id`).all() as Challenge[];
  },
  get(id: number): Challenge | undefined {
    return db().prepare('SELECT * FROM reward_challenges WHERE id = ?').get(id) as Challenge | undefined;
  },
  create(c: ChallengeInput): number {
    return Number(
      db()
        .prepare('INSERT INTO reward_challenges (title, description, metric, threshold, reward_id, reward_label, emoji, position, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(c.title, c.description, c.metric, c.threshold, c.reward_id, c.reward_label, c.emoji, c.position, c.enabled ? 1 : 0).lastInsertRowid,
    );
  },
  update(id: number, c: ChallengeInput): void {
    db()
      .prepare('UPDATE reward_challenges SET title = ?, description = ?, metric = ?, threshold = ?, reward_id = ?, reward_label = ?, emoji = ?, position = ?, enabled = ? WHERE id = ?')
      .run(c.title, c.description, c.metric, c.threshold, c.reward_id, c.reward_label, c.emoji, c.position, c.enabled ? 1 : 0, id);
  },
  remove(id: number): void {
    db().prepare('DELETE FROM reward_challenges WHERE id = ?').run(id);
  },
  removeAll(): number {
    return db().prepare('DELETE FROM reward_challenges').run().changes;
  },
  setEnabled(id: number, enabled: boolean): void {
    db().prepare('UPDATE reward_challenges SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  },
  nextPosition(): number {
    return (db().prepare('SELECT COALESCE(MAX(position), 0) + 1 p FROM reward_challenges').get() as { p: number }).p;
  },
  /** Déplace un défi d'un cran dans la liste affichée par /rewards. */
  move(id: number, delta: -1 | 1): void {
    const list = challenges.list();
    const idx = list.findIndex((c) => c.id === id);
    const target = idx + delta;
    if (idx < 0 || target < 0 || target >= list.length) return;
    [list[idx], list[target]] = [list[target], list[idx]];
    const stmt = db().prepare('UPDATE reward_challenges SET position = ? WHERE id = ?');
    db().transaction(() => list.forEach((c, i) => stmt.run(i + 1, c.id)))();
  },
  thresholds(metric: Metric): number[] {
    return (db().prepare('SELECT threshold FROM reward_challenges WHERE enabled = 1 AND metric = ?').all(metric) as { threshold: number }[]).map((r) => r.threshold);
  },
};

export const unlocks = {
  forUser(userId: string): Map<number, number> {
    const rows = db().prepare('SELECT challenge_id, unlocked_at FROM reward_unlocks WHERE user_id = ?').all(userId) as { challenge_id: number; unlocked_at: number }[];
    return new Map(rows.map((r) => [r.challenge_id, r.unlocked_at]));
  },
  /** true si le défi vient d'être débloqué (insertion atomique : jamais deux fois). */
  add(userId: string, challengeId: number): boolean {
    return db().prepare('INSERT OR IGNORE INTO reward_unlocks (user_id, challenge_id, unlocked_at) VALUES (?, ?, ?)').run(userId, challengeId, Date.now()).changes === 1;
  },
  /** Identifiants de récompense à livrer en jeu (défis actifs uniquement, sans doublon). */
  rewardIds(userId: string): string[] {
    return (
      db()
        .prepare('SELECT DISTINCT c.reward_id FROM reward_unlocks u JOIN reward_challenges c ON c.id = u.challenge_id WHERE u.user_id = ? AND c.enabled = 1 ORDER BY c.reward_id')
        .all(userId) as { reward_id: string }[]
    ).map((r) => r.reward_id);
  },
  count(userId: string): number {
    return (db().prepare('SELECT COUNT(*) n FROM reward_unlocks WHERE user_id = ?').get(userId) as { n: number }).n;
  },
};

export const links = {
  get(discordId: string): RobloxLink | undefined {
    return db().prepare('SELECT * FROM roblox_links WHERE discord_id = ?').get(discordId) as RobloxLink | undefined;
  },
  byRoblox(robloxId: string): RobloxLink | undefined {
    return db().prepare('SELECT * FROM roblox_links WHERE roblox_id = ?').get(robloxId) as RobloxLink | undefined;
  },
  list(): RobloxLink[] {
    return db().prepare('SELECT * FROM roblox_links ORDER BY linked_at DESC').all() as RobloxLink[];
  },
  save(discordId: string, p: { id: string; username: string; displayName: string | null }): void {
    db()
      .prepare(
        `INSERT INTO roblox_links (discord_id, roblox_id, roblox_username, roblox_display_name, linked_at, needs_sync) VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(discord_id) DO UPDATE SET roblox_username = excluded.roblox_username, roblox_display_name = excluded.roblox_display_name, needs_sync = 1`,
      )
      .run(discordId, p.id, p.username, p.displayName, Date.now());
  },
  remove(discordId: string): void {
    db().prepare('DELETE FROM roblox_links WHERE discord_id = ?').run(discordId);
  },
  markDirty(discordId?: string): void {
    if (discordId) db().prepare('UPDATE roblox_links SET needs_sync = 1 WHERE discord_id = ?').run(discordId);
    else db().prepare('UPDATE roblox_links SET needs_sync = 1').run();
  },
  markSynced(discordId: string): void {
    db().prepare('UPDATE roblox_links SET needs_sync = 0, synced_at = ?, sync_error = NULL WHERE discord_id = ?').run(Date.now(), discordId);
  },
  markError(discordId: string, error: string): void {
    db().prepare('UPDATE roblox_links SET sync_error = ? WHERE discord_id = ?').run(error, discordId);
  },
  dirty(): RobloxLink[] {
    return db().prepare('SELECT * FROM roblox_links WHERE needs_sync = 1').all() as RobloxLink[];
  },
};

export const activity = {
  get(userId: string): { messages: number; voice_seconds: number; last_message_at: number | null } {
    return (
      (db().prepare('SELECT messages, voice_seconds, last_message_at FROM user_activity WHERE user_id = ?').get(userId) as
        | { messages: number; voice_seconds: number; last_message_at: number | null }
        | undefined) ?? { messages: 0, voice_seconds: 0, last_message_at: null }
    );
  },
  /** Compte un message ; retourne le nouveau total. */
  addMessage(userId: string): number {
    db()
      .prepare('INSERT INTO user_activity (user_id, messages, last_message_at) VALUES (?, 1, ?) ON CONFLICT(user_id) DO UPDATE SET messages = messages + 1, last_message_at = excluded.last_message_at')
      .run(userId, Date.now());
    return activity.get(userId).messages;
  },
  addVoice(userIds: string[], seconds: number): void {
    const stmt = db().prepare('INSERT INTO user_activity (user_id, voice_seconds) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET voice_seconds = voice_seconds + excluded.voice_seconds');
    db().transaction(() => userIds.forEach((id) => stmt.run(id, seconds)))();
  },
  /** true si la réaction est comptée (une seule fois par annonce et par membre). */
  addAnnouncementReaction(userId: string, messageId: string, channelId: string): boolean {
    return db().prepare('INSERT OR IGNORE INTO announcement_reactions (user_id, message_id, channel_id, reacted_at) VALUES (?, ?, ?, ?)').run(userId, messageId, channelId, Date.now()).changes === 1;
  },
};

/** Défis proposés à l'installation (titres, seuils et récompenses modifiables dans le panel). */
export const DEFAULT_CHALLENGES: ChallengeInput[] = [
  { title: 'Relier son compte Roblox', description: 'Connecte ton compte Roblox avec /rewards.', metric: 'linked', threshold: 1, reward_id: 'title_genin', reward_label: 'Titre « Genin »', emoji: '🔗', position: 1, enabled: true },
  { title: 'Inviter 1 ami', description: 'Invite un ami sur le serveur Discord.', metric: 'invites', threshold: 1, reward_id: 'ryo_500', reward_label: '500 Ryō', emoji: '📨', position: 2, enabled: true },
  { title: 'Inviter 5 amis', description: 'Ils doivent toujours être sur le serveur.', metric: 'invites', threshold: 5, reward_id: 'title_recruteur', reward_label: 'Titre « Recruteur »', emoji: '📨', position: 3, enabled: true },
  { title: 'Inviter 10 amis', description: 'Ils doivent toujours être sur le serveur.', metric: 'invites', threshold: 10, reward_id: 'cape_ombre', reward_label: 'Cape de l’Ombre', emoji: '🏅', position: 4, enabled: true },
  { title: 'Rejoindre la bêta', description: 'Avoir sa candidature bêta acceptée.', metric: 'beta', threshold: 1, reward_id: 'badge_testeur', reward_label: 'Badge « Testeur de la première heure »', emoji: '🧪', position: 5, enabled: true },
  { title: 'Participer à 3 sessions de test', description: 'Être inscrit à 3 sessions de test terminées.', metric: 'test_sessions', threshold: 3, reward_id: 'ryo_1000', reward_label: '1 000 Ryō', emoji: '🎮', position: 6, enabled: true },
  { title: 'Faire corriger un bug', description: 'Signaler un bug (/bugreport) qui est ensuite corrigé.', metric: 'bugs_resolved', threshold: 1, reward_id: 'title_chasseur', reward_label: 'Titre « Chasseur de bugs »', emoji: '🐞', position: 7, enabled: true },
  { title: 'Faire accepter une suggestion', description: 'Proposer une idée (/suggestion) retenue par l’équipe.', metric: 'suggestions_accepted', threshold: 1, reward_id: 'title_visionnaire', reward_label: 'Titre « Visionnaire »', emoji: '💡', position: 8, enabled: true },
  { title: 'Booster le serveur', description: 'Booster le serveur Discord avec Nitro.', metric: 'boost', threshold: 1, reward_id: 'aura_booster', reward_label: 'Aura exclusive Booster', emoji: '💎', position: 9, enabled: true },
  { title: 'Passer 10 h en vocal', description: 'Avec au moins une autre personne, sans être en sourdine.', metric: 'voice_minutes', threshold: 600, reward_id: 'emote_salut', reward_label: 'Emote « Salut shinobi »', emoji: '🎙️', position: 10, enabled: true },
  { title: 'Envoyer 500 messages', description: 'Le spam n’est pas compté.', metric: 'messages', threshold: 500, reward_id: 'ryo_750', reward_label: '750 Ryō', emoji: '💬', position: 11, enabled: true },
  { title: 'Voter à 5 sondages', description: 'Donne ton avis sur les sondages de l’équipe.', metric: 'polls', threshold: 5, reward_id: 'title_stratege', reward_label: 'Titre « Stratège »', emoji: '🗳️', position: 12, enabled: true },
  { title: 'Réagir à 10 annonces', description: 'Réagis dans l’heure qui suit la publication d’une annonce.', metric: 'announcement_reactions', threshold: 10, reward_id: 'ryo_300', reward_label: '300 Ryō', emoji: '📢', position: 13, enabled: true },
];

export function seedChallenges(): void {
  const done = db().prepare("SELECT 1 FROM settings WHERE key = 'internal.rewardsSeeded'").get();
  if (done) return;
  db().transaction(() => {
    if (!challenges.list().length) for (const c of DEFAULT_CHALLENGES) challenges.create(c);
    db().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('internal.rewardsSeeded', 'true', ?)").run(Date.now());
  })();
}
