import crypto from 'node:crypto';
import { tryGetGuild } from '../../bot/client';
import { brandEmbed } from '../../bot/ui/embeds';
import { audit } from '../audit/audit';
import { links } from './rewards.repo';
import { evaluate, syncUser } from './rewards.service';
import type { RobloxProfile } from './roblox';

/**
 * Liaison sans nom de domaine : le joueur colle une phrase dans la description de son profil Roblox,
 * le bot la lit via l'API publique de Roblox. Seules des requêtes sortantes sont nécessaires.
 */

const USERS_API = 'https://users.roblox.com/v1';

/** Mots simples, sans chiffres (le filtre de Roblox masque souvent les chiffres dans les descriptions). */
const WORDS = [
  'katon', 'raiton', 'suiton', 'futon', 'doton', 'kunai', 'shinobi', 'dojo', 'lotus', 'tonnerre',
  'tempete', 'flamme', 'riviere', 'falaise', 'bambou', 'cerisier', 'lune', 'soleil', 'nuage', 'orage',
  'renard', 'faucon', 'tigre', 'dragon', 'loup', 'corbeau', 'serpent', 'tortue', 'montagne', 'foret',
  'ocean', 'volcan', 'cascade', 'temple', 'lanterne', 'parchemin', 'sabre', 'bouclier', 'eclair', 'brume',
];
export const PHRASE_WORDS = 5;

export function generatePhrase(): string {
  return Array.from({ length: PHRASE_WORDS }, () => WORDS[crypto.randomInt(WORDS.length)]).join(' ');
}

/** Tolère majuscules, accents et espaces multiples (la description peut contenir d'autres textes). */
export function descriptionHasPhrase(description: string, phrase: string): boolean {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  return norm(description).includes(norm(phrase));
}

export async function lookupRobloxUser(username: string): Promise<RobloxProfile | null> {
  const res = await fetch(`${USERS_API}/usernames/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Roblox ne répond pas (code ${res.status}). Réessaie dans un instant.`);
  const json = (await res.json()) as { data?: { id: number; name: string; displayName: string }[] };
  const u = json.data?.[0];
  return u ? { id: String(u.id), username: u.name, displayName: u.displayName } : null;
}

export async function fetchRobloxProfile(id: string): Promise<RobloxProfile & { description: string }> {
  const res = await fetch(`${USERS_API}/users/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Lecture du profil Roblox impossible (code ${res.status}). Réessaie dans un instant.`);
  const u = (await res.json()) as { id: number; name: string; displayName: string; description?: string };
  return { id: String(u.id), username: u.name, displayName: u.displayName, description: u.description ?? '' };
}

// ───────────── Vérifications en cours (30 minutes) ─────────────

export interface PendingVerification {
  profile: RobloxProfile;
  phrase: string;
  expires: number;
}

const pending = new Map<string, PendingVerification>();

export function startVerification(discordId: string, profile: RobloxProfile): PendingVerification {
  const t = Date.now();
  for (const [k, v] of pending) if (v.expires < t) pending.delete(k);
  // On garde la même phrase si le joueur relance pour le même compte (il l'a peut-être déjà collée).
  const existing = pending.get(discordId);
  const phrase = existing && existing.profile.id === profile.id && existing.expires > t ? existing.phrase : generatePhrase();
  const v = { profile, phrase, expires: t + 30 * 6e4 };
  pending.set(discordId, v);
  return v;
}

export function getVerification(discordId: string): PendingVerification | null {
  const v = pending.get(discordId);
  if (!v || v.expires < Date.now()) {
    pending.delete(discordId);
    return null;
  }
  return v;
}

export function cancelVerification(discordId: string): void {
  pending.delete(discordId);
}

/** Vérifie que l'association est permise (un compte Roblox ↔ un compte Discord). Retourne un message d'erreur ou null. */
export function linkConflict(discordId: string, profile: RobloxProfile): string | null {
  const owner = links.byRoblox(profile.id);
  if (owner && owner.discord_id !== discordId) return `Le compte Roblox ${profile.username} est déjà relié à un autre compte Discord. Si c’est une erreur, ouvre un ticket.`;
  const current = links.get(discordId);
  if (current && current.roblox_id !== profile.id) return `Ton Discord est déjà relié au compte Roblox ${current.roblox_username}. Pour en changer, demande au staff (ouvre un ticket).`;
  return null;
}

/** Enregistre la liaison (quelle que soit la méthode), débloque/livre les récompenses et prévient le joueur. */
export async function completeLink(discordId: string, profile: RobloxProfile, method: string): Promise<string | null> {
  const conflict = linkConflict(discordId, profile);
  if (conflict) return conflict;
  links.save(discordId, profile);
  cancelVerification(discordId);
  await audit({ type: 'community', action: 'roblox_link', actorId: discordId, message: `🔗 <@${discordId}> a relié son compte Roblox **${profile.username}** (${profile.id}) — ${method}.` });
  await evaluate(discordId).catch(() => undefined);
  void syncUser(discordId);
  const member = await tryGetGuild()?.members.fetch(discordId).catch(() => null);
  await member
    ?.send({ embeds: [brandEmbed({ title: '🔗 Compte Roblox relié', description: `Ton compte Discord est maintenant relié à **${profile.username}**. Tes récompenses débloquées arriveront en jeu automatiquement. Suis tes défis avec \`/rewards\`.` })] })
    .catch(() => undefined);
  return null;
}
