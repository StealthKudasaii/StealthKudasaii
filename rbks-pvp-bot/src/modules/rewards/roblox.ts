import crypto from 'node:crypto';
import { env } from '../../config/env';

/**
 * Intégrations Roblox :
 *  - connexion officielle « Se connecter avec Roblox » (OAuth 2.0 + PKCE), pour relier un compte ;
 *  - Open Cloud : écriture des récompenses dans un DataStore du jeu, et notification des serveurs en ligne.
 */

const AUTHORIZE_URL = 'https://apis.roblox.com/oauth/v1/authorize';
const TOKEN_URL = 'https://apis.roblox.com/oauth/v1/token';
const USERINFO_URL = 'https://apis.roblox.com/oauth/v1/userinfo';
const OPEN_CLOUD = 'https://apis.roblox.com';

export const oauthConfigured = () => !!(env().ROBLOX_OAUTH_CLIENT_ID && env().ROBLOX_OAUTH_CLIENT_SECRET);
export const openCloudConfigured = () => !!(env().ROBLOX_OPEN_CLOUD_API_KEY && env().ROBLOX_UNIVERSE_ID);
export const robloxRedirectUri = () => `${env().PUBLIC_URL}/roblox/callback`;

// ───────────── Liaison : jetons à usage unique ─────────────

interface PendingLink {
  discordId: string;
  expires: number;
  state?: string;
  verifier?: string;
}

/** Jeton (lien envoyé en privé dans /rewards) → membre Discord. Valable 10 minutes, usage unique. */
const linkTokens = new Map<string, PendingLink>();
/** state OAuth → demande en cours. */
const pendingStates = new Map<string, PendingLink>();

function purge() {
  const t = Date.now();
  for (const [k, v] of linkTokens) if (v.expires < t) linkTokens.delete(k);
  for (const [k, v] of pendingStates) if (v.expires < t) pendingStates.delete(k);
}

export function createLinkToken(discordId: string): string {
  purge();
  const token = crypto.randomBytes(24).toString('base64url');
  linkTokens.set(token, { discordId, expires: Date.now() + 10 * 6e4 });
  return token;
}

/** Consomme le jeton et prépare la redirection vers Roblox (PKCE S256). */
export function startAuthorization(token: string): string | null {
  purge();
  const pending = linkTokens.get(token);
  if (!pending) return null;
  linkTokens.delete(token);
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  pendingStates.set(state, { discordId: pending.discordId, expires: Date.now() + 10 * 6e4, state, verifier });
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', env().ROBLOX_OAUTH_CLIENT_ID!);
  url.searchParams.set('redirect_uri', robloxRedirectUri());
  url.searchParams.set('scope', 'openid profile');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', crypto.randomBytes(16).toString('base64url'));
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface RobloxProfile {
  id: string;
  username: string;
  displayName: string | null;
}

/** Termine la connexion : vérifie le state, échange le code, lit le profil. Le jeton Roblox n'est pas conservé. */
export async function finishAuthorization(state: string, code: string): Promise<{ discordId: string; profile: RobloxProfile }> {
  purge();
  const pending = pendingStates.get(state);
  if (!pending) throw new Error('Lien expiré ou déjà utilisé : refais /rewards sur Discord.');
  pendingStates.delete(state);
  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env().ROBLOX_OAUTH_CLIENT_ID!,
      client_secret: env().ROBLOX_OAUTH_CLIENT_SECRET!,
      grant_type: 'authorization_code',
      code,
      code_verifier: pending.verifier!,
      redirect_uri: robloxRedirectUri(),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenRes.ok) throw new Error(`Roblox a refusé la connexion (code ${tokenRes.status}). Vérifie l’URL de redirection et le secret de l’application OAuth.`);
  const token = (await tokenRes.json()) as { access_token: string };
  const infoRes = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(10_000) });
  if (!infoRes.ok) throw new Error(`Lecture du profil Roblox impossible (code ${infoRes.status}).`);
  const info = (await infoRes.json()) as { sub: string; preferred_username?: string; nickname?: string; name?: string };
  if (!/^\d+$/.test(info.sub ?? '')) throw new Error('Réponse Roblox inattendue.');
  return { discordId: pending.discordId, profile: { id: info.sub, username: info.preferred_username ?? info.nickname ?? info.sub, displayName: info.name ?? null } };
}

// ───────────── Open Cloud ─────────────

export interface RewardsEntry {
  discordId: string;
  robloxId: string;
  rewards: string[];
  updatedAt: string;
}

/** Écrit la liste complète des récompenses débloquées du joueur (clé = son UserId Roblox). */
export async function writeRewardsEntry(entry: RewardsEntry): Promise<void> {
  const e = env();
  const body = JSON.stringify(entry);
  const url = new URL(`${OPEN_CLOUD}/datastores/v1/universes/${e.ROBLOX_UNIVERSE_ID}/standard-datastores/datastore/entries/entry`);
  url.searchParams.set('datastoreName', e.ROBLOX_DATASTORE);
  url.searchParams.set('entryKey', entry.robloxId);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': e.ROBLOX_OPEN_CLOUD_API_KEY!,
      'content-type': 'application/json',
      'content-md5': crypto.createHash('md5').update(body).digest('base64'),
      // Associe l'entrée au joueur (outils RGPD de Roblox).
      'roblox-entry-userids': JSON.stringify([Number(entry.robloxId)]),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(openCloudError(res.status, await res.text().catch(() => '')));
}

/** Prévient les serveurs de jeu en ligne qu'un joueur a de nouvelles récompenses (facultatif, sans erreur bloquante). */
export async function notifyGameServers(robloxId: string): Promise<boolean> {
  const e = env();
  const res = await fetch(`${OPEN_CLOUD}/messaging-service/v1/universes/${e.ROBLOX_UNIVERSE_ID}/topics/${encodeURIComponent(e.ROBLOX_MESSAGING_TOPIC)}`, {
    method: 'POST',
    headers: { 'x-api-key': e.ROBLOX_OPEN_CLOUD_API_KEY!, 'content-type': 'application/json' },
    body: JSON.stringify({ message: robloxId }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  return !!res?.ok;
}

export function openCloudError(status: number, text: string): string {
  if (status === 401) return 'Clé API Open Cloud invalide (401).';
  if (status === 403) return 'Clé API sans les droits nécessaires sur cette expérience (403) : ajoute « DataStore : écriture » pour l’expérience dans le Creator Dashboard, et l’adresse IP du VPS si tu as restreint la clé.';
  if (status === 404) return 'Expérience introuvable (404) : vérifie ROBLOX_UNIVERSE_ID.';
  if (status === 429) return 'Trop de requêtes vers Roblox (429) : nouvel essai automatique plus tard.';
  return `Erreur Open Cloud ${status}${text ? ` : ${text.slice(0, 200)}` : ''}`;
}
