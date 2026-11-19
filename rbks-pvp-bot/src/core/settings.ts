import { db, parseJson } from '../db';

/** Valeurs par défaut de toutes les options modifiables (Discord ou panel). */
export const SETTING_DEFAULTS = {
  'brand.name': 'RBKS PVP',
  'brand.color': '#FF4D2E',
  'brand.footer': 'RBKS PVP • Arène Shinobi',
  'brand.logoUrl': '' as string,
  'bot.presence': { status: 'online', activityType: 'Playing', activityText: 'RBKS PVP' } as {
    status: 'online' | 'idle' | 'dnd' | 'invisible';
    activityType: 'Playing' | 'Watching' | 'Listening' | 'Competing' | 'Custom';
    activityText: string;
  },
  'bot.nickname': '' as string,
  /** Salons réaffectés manuellement depuis le panel (clé du salon → id). Prioritaire sur /setup. */
  'channels.overrides': {} as Record<string, string>,
  'logs.enabled': {
    members: true,
    sanctions: true,
    tickets: true,
    applications: true,
    roadmap: true,
    tasks: true,
    publications: true,
    admin: true,
    community: true,
  } as Record<string, boolean>,
  'members.autoroleOnJoin': false,
  'welcome.enabled': true,
  'welcome.message':
    'Bienvenue {membre} sur **{serveur}** ! Tu es notre **{nombre}ᵉ** membre 🔥\n\nLis le règlement dans {regles}, puis choisis tes notifications dans {notifications}.',
  'welcome.imageUrl': '' as string,
  'welcome.dmEnabled': false,
  'welcome.dmMessage': 'Bienvenue sur **{serveur}**, {pseudo} ! Pense à lire le règlement et à suivre l’actualité du jeu. Bon jeu ⚔️',
  'rules.title': '📜 Règlement de RBKS PVP',
  'rules.text':
    '**1.** Respecte tous les membres, staff comme joueurs.\n**2.** Pas de spam, de pub ou de contenu NSFW.\n**3.** Pas de triche, d’exploit ou de partage de failles : signale-les avec `/bugreport`.\n**4.** Les spoils restent dans #spoil.\n**5.** Les décisions du staff s’appliquent ; conteste-les calmement via un ticket.\n\nClique sur le bouton ci-dessous pour confirmer que tu as lu le règlement.',
  'tickets.closeMode': 'delete' as 'delete' | 'archive',
  'tickets.maxOpenPerUser': 1,
  'tickets.cooldownSeconds': 120,
  'tickets.panelTitle': '🎫 Support RBKS PVP',
  'tickets.panelDescription':
    'Besoin d’aide ? Une question sur le jeu, un problème technique ou un joueur à signaler ?\n\nClique sur **Ouvrir un ticket**, choisis le motif et décris ta demande. Un membre du staff te répondra dans un salon privé.',
  'tickets.welcomeMessage': 'Merci d’avoir ouvert un ticket. Décris ton problème le plus précisément possible, un membre du staff va te répondre.',
  'tickets.dmTranscript': false,
  'suggestions.createThread': true,
  'suggestions.cooldownSeconds': 300,
  'bugs.cooldownSeconds': 120,
  'testsessions.reminderMinutes': 30,
  /** Messages « panneau » publiés par le bot (clé → salon/message). */
  'panels': {} as Record<string, { channelId: string; messageId: string }>,
  'internal.lastBackup': 0,
  /** Message d’en-tête de la roadmap. */
  'roadmap.header': null as { channelId: string; messageId: string } | null,
};

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type SettingValue<K extends SettingKey> = (typeof SETTING_DEFAULTS)[K];

const cache = new Map<string, unknown>();

export function getSetting<K extends SettingKey>(key: K): SettingValue<K> {
  if (cache.has(key)) return cache.get(key) as SettingValue<K>;
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  const def = SETTING_DEFAULTS[key];
  let value = row ? parseJson<SettingValue<K>>(row.value, def) : def;
  // Fusionne les nouveaux champs par défaut des objets (mise à jour du bot).
  if (row && def && typeof def === 'object' && !Array.isArray(def) && value && typeof value === 'object') {
    value = { ...(def as object), ...(value as object) } as SettingValue<K>;
  }
  cache.set(key, value);
  return value;
}

export function setSetting<K extends SettingKey>(key: K, value: SettingValue<K>): void {
  db()
    .prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
    .run(key, JSON.stringify(value), Date.now());
  cache.set(key, value);
}

export function clearSettingsCache(): void {
  cache.clear();
}

export function brandColor(): number {
  const hex = getSetting('brand.color').replace('#', '');
  const n = Number.parseInt(hex, 16);
  return Number.isFinite(n) ? n : 0xff4d2e;
}
