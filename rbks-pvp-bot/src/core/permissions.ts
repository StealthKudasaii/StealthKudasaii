import { GuildMember, PermissionFlagsBits } from 'discord.js';
import { db, parseJson } from '../db';
import { env } from '../config/env';
import type { RoleKey } from '../config/layout';
import { roleId } from './resources';

/**
 * Permissions fonctionnelles du bot, vérifiées côté serveur à chaque commande, bouton ou action du panel.
 * Elles sont indépendantes des permissions d'affichage Discord.
 */
export const FEATURES = {
  'setup': { label: 'Configuration du serveur (/setup)', group: 'Administration', defaults: ['founder', 'cofounder'] },
  'permissions': { label: 'Gestion des permissions du bot', group: 'Administration', defaults: ['founder'] },
  'bot.manage': { label: 'Profil et présence du bot', group: 'Administration', defaults: ['founder'] },
  'panel.access': { label: 'Accès au panel web', group: 'Administration', defaults: ['founder', 'cofounder', 'admin'] },
  'settings.manage': { label: 'Réglages généraux (salons, logs, marque)', group: 'Administration', defaults: ['founder', 'cofounder'] },
  'logs.view': { label: 'Consultation des logs', group: 'Administration', defaults: ['founder', 'cofounder', 'admin'] },
  'stats.view': { label: 'Statistiques détaillées', group: 'Administration', defaults: ['founder', 'cofounder', 'admin', 'moderator', 'support', 'developer'] },
  'tickets.handle': { label: 'Traiter les tickets', group: 'Support', defaults: ['founder', 'cofounder', 'admin', 'moderator', 'support'] },
  'tickets.manage': { label: 'Configurer les tickets', group: 'Support', defaults: ['founder', 'cofounder', 'admin'] },
  'whitelist.manage': { label: 'Créer/modifier les formulaires', group: 'Candidatures', defaults: ['founder', 'cofounder', 'admin'] },
  'whitelist.review': { label: 'Examiner les candidatures (tous formulaires)', group: 'Candidatures', defaults: ['founder', 'cofounder', 'admin'] },
  'dev.manage': { label: 'Versions et roadmap', group: 'Développement', defaults: ['founder', 'cofounder', 'admin', 'developer'] },
  'tasks.manage': { label: 'Tâches de développement', group: 'Développement', defaults: ['founder', 'cofounder', 'admin', 'developer'] },
  'publications.manage': { label: 'Annonces et patch notes', group: 'Communication', defaults: ['founder', 'cofounder', 'admin'] },
  'notifications.manage': { label: 'Rôles de notification', group: 'Communication', defaults: ['founder', 'cofounder', 'admin'] },
  'suggestions.manage': { label: 'Gérer les suggestions', group: 'Communauté', defaults: ['founder', 'cofounder', 'admin', 'moderator'] },
  'bugs.manage': { label: 'Gérer les bugs', group: 'Communauté', defaults: ['founder', 'cofounder', 'admin', 'moderator', 'developer'] },
  'testsessions.manage': { label: 'Sessions de test', group: 'Communauté', defaults: ['founder', 'cofounder', 'admin', 'developer'] },
  'massdm.manage': { label: 'Messages privés groupés et clés d’accès', group: 'Communication', defaults: ['founder', 'cofounder'] },
  'polls.manage': { label: 'Sondages', group: 'Communauté', defaults: ['founder', 'cofounder', 'admin', 'moderator'] },
} satisfies Record<string, { label: string; group: string; defaults: RoleKey[] }>;

export type Feature = keyof typeof FEATURES;

export function isFeature(x: string): x is Feature {
  return Object.prototype.hasOwnProperty.call(FEATURES, x);
}

/** Rôles autorisés pour une fonctionnalité : configuration explicite, sinon rôles par défaut créés par /setup. */
export function featureRoleIds(feature: Feature): string[] {
  const row = db().prepare('SELECT role_ids FROM feature_roles WHERE feature = ?').get(feature) as { role_ids: string } | undefined;
  if (row) return parseJson<string[]>(row.role_ids, []);
  return (FEATURES[feature].defaults as RoleKey[]).map((k) => roleId(k)).filter((x): x is string => !!x);
}

export function isFeatureCustomized(feature: Feature): boolean {
  return !!db().prepare('SELECT 1 FROM feature_roles WHERE feature = ?').get(feature);
}

export function setFeatureRoles(feature: Feature, roleIds: string[] | null): void {
  if (roleIds === null) {
    db().prepare('DELETE FROM feature_roles WHERE feature = ?').run(feature);
    return;
  }
  const unique = [...new Set(roleIds.filter((r) => /^\d{17,20}$/.test(r)))];
  db()
    .prepare(
      'INSERT INTO feature_roles (feature, role_ids, updated_at) VALUES (?, ?, ?) ON CONFLICT(feature) DO UPDATE SET role_ids = excluded.role_ids, updated_at = excluded.updated_at',
    )
    .run(feature, JSON.stringify(unique), Date.now());
}

/** Propriétaire du serveur, membres avec Administrateur, ou BOT_OWNER_IDS : accès total. */
export function isSuperUser(member: GuildMember): boolean {
  if (member.guild.ownerId === member.id) return true;
  if (env().BOT_OWNER_IDS.includes(member.id)) return true;
  return member.permissions.has(PermissionFlagsBits.Administrator);
}

export function can(member: GuildMember | null | undefined, feature: Feature, extraRoleIds: string[] = []): boolean {
  if (!member) return false;
  if (isSuperUser(member)) return true;
  const allowed = new Set([...featureRoleIds(feature), ...extraRoleIds]);
  return member.roles.cache.some((r) => allowed.has(r.id));
}

export function featuresFor(member: GuildMember): Feature[] {
  return (Object.keys(FEATURES) as Feature[]).filter((f) => can(member, f));
}
