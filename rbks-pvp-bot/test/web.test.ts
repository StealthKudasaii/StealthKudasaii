import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { Collection } from 'discord.js';
import { freshDb } from './helpers';
import { __setClientForTests } from '../src/bot/client';
import { createApp } from '../src/web/server';
import { db } from '../src/db';
import { forms, questions } from '../src/modules/whitelist/forms.repo';
import { tasks, roadmap } from '../src/modules/dev/dev.repo';
import { reasons } from '../src/modules/tickets/tickets.repo';
import { featureRoleIds } from '../src/core/permissions';
import { campaigns, recipients } from '../src/modules/massdm/massdm.repo';
import { getSetting } from '../src/core/settings';
import { challenges as rewardChallenges } from '../src/modules/rewards/rewards.repo';
const challengesList = () => rewardChallenges.list();
// eslint-disable-next-line @typescript-eslint/no-require-imports
const signature = require('cookie-signature') as { sign(v: string, s: string): string };

const GUILD = process.env.GUILD_ID!;
const OWNER = '400000000000000004';
const OUTSIDER = '400000000000000005';
let server: Server;
let base = '';
const SID = 'test-session-id';
const CSRF = 'c'.repeat(64);
const role = { id: '500000000000000005', name: '🛡️ Administrateur', hexColor: '#e74c3c', position: 5, managed: false };

function fakeMember(id: string, owner: boolean) {
  return {
    id,
    displayName: owner ? 'Fondateur' : 'Inconnu',
    user: { tag: `${id}#0`, bot: false, createdTimestamp: Date.now() - 1e10 },
    guild: { ownerId: OWNER },
    permissions: { has: () => false },
    roles: { cache: new Collection<string, unknown>(), highest: { position: 99 } },
    joinedTimestamp: Date.now() - 1e9,
    displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png',
  };
}

before(async () => {
  freshDb();
  const members = new Collection<string, ReturnType<typeof fakeMember>>([
    [OWNER, fakeMember(OWNER, true)],
    [OUTSIDER, fakeMember(OUTSIDER, false)],
  ]);
  const guild = {
    id: GUILD,
    name: 'RBKS PVP',
    ownerId: OWNER,
    memberCount: 2,
    iconURL: () => null,
    roles: { cache: new Collection([[role.id, role]]) },
    channels: { cache: new Collection(), fetch: async () => null },
    members: { cache: members, fetch: async (id: string) => members.get(id) ?? Promise.reject(new Error('Unknown Member')), me: { roles: { highest: { position: 99 } } } },
  };
  __setClientForTests({
    guilds: { cache: new Collection([[GUILD, guild]]) },
    isReady: () => true,
    user: { tag: 'RBKS Bot#0001', username: 'RBKS Bot', id: '1', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/1.png' },
    ws: { ping: 42 },
  });
  const app = createApp();
  await new Promise<void>((r) => {
    server = app.listen(0, '127.0.0.1', () => r());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

function login(userId: string, sid = SID) {
  const sess = { cookie: { originalMaxAge: 864e5, expires: new Date(Date.now() + 864e5).toISOString(), httpOnly: true, path: '/' }, user: { id: userId, username: 'test', globalName: null, avatar: null }, csrf: CSRF };
  db().prepare('INSERT OR REPLACE INTO web_sessions (sid, sess, expires) VALUES (?, ?, ?)').run(sid, JSON.stringify(sess), Date.now() + 864e5);
  return `rbks.sid=${encodeURIComponent('s:' + signature.sign(sid, process.env.SESSION_SECRET!))}`;
}

const get = (path: string, cookie?: string) => fetch(base + path, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
const post = (path: string, body: Record<string, string>, cookie: string) =>
  fetch(base + path, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), redirect: 'manual' });

test('pages publiques et redirection vers la connexion', async () => {
  assert.equal((await get('/health')).status, 200);
  const login = await get('/login');
  assert.equal(login.status, 200);
  assert.match(await login.text(), /Se connecter avec Discord/);
  const dash = await get('/');
  assert.equal(dash.status, 302);
  assert.equal(dash.headers.get('location'), '/login');
  const oauth = await get('/auth/discord');
  assert.equal(oauth.status, 302);
  assert.match(oauth.headers.get('location')!, /discord\.com\/oauth2\/authorize.*scope=identify.*state=/);
});

test('callback OAuth2 refusé sans état valide', async () => {
  const r = await get('/auth/callback?code=abc&state=forged');
  assert.equal(r.status, 400);
});

test('un membre sans rôle autorisé est refusé', async () => {
  const cookie = login(OUTSIDER, 'outsider-session');
  const r = await get('/', cookie);
  assert.equal(r.status, 403);
});

test('toutes les pages du panel s’affichent pour le Fondateur', async () => {
  const cookie = login(OWNER);
  const fid = forms.create({ name: 'beta-web', title: 'Bêta', description: '', button_label: 'Go', banner_url: null, review_channel_id: null, accepted_role_id: null, created_by: OWNER });
  questions.create(fid, { label: 'Pseudo', type: 'roblox', required: true });
  const pages = ['/', '/bot', '/settings', '/permissions', '/logs', '/tickets', '/forms', `/forms/${fid}`, '/applications', '/dev/versions', '/dev/tasks', '/dev/roadmap', '/publications', '/suggestions', '/bugs', '/bugs?status=all', '/sessions', '/polls', '/massdm', '/rewards'];
  for (const p of pages) {
    const r = await get(p, cookie);
    const body = await r.text();
    assert.equal(r.status, 200, `${p} → ${r.status}\n${body.slice(0, 500)}`);
    assert.match(body, /Panel RBKS PVP/, p);
  }
  assert.equal((await get('/page-inexistante', cookie)).status, 404);
});

test('protection CSRF sur les modifications', async () => {
  const cookie = login(OWNER);
  const r = await post('/tickets/reasons', { label: 'Pirate', _csrf: 'mauvais' }, cookie);
  assert.equal(r.status, 403);
  assert.equal(reasons.list().some((x) => x.label === 'Pirate'), false);
});

test('actions du panel enregistrées en base', async () => {
  const cookie = login(OWNER);
  // Motif de ticket
  let r = await post('/tickets/reasons', { label: 'Partenariat', emoji: '🤝', description: 'Demande de partenariat', _csrf: CSRF }, cookie);
  assert.equal(r.status, 302);
  assert.ok(reasons.list().some((x) => x.label === 'Partenariat'));
  // Formulaire + question à choix
  r = await post('/forms', { name: 'beta-2', title: 'Bêta 2', button: 'Postuler', template: 'on', _csrf: CSRF }, cookie);
  const f = forms.byName('beta-2')!;
  assert.equal(r.headers.get('location'), `/forms/${f.id}`);
  assert.equal(questions.count(f.id), 7);
  r = await post(`/forms/${f.id}/questions`, { label: 'Ton élément préféré ?', type: 'single', required: 'on', choices: 'Katon\nRaiton\nSuiton', _csrf: CSRF }, cookie);
  assert.equal(questions.count(f.id), 8);
  // Tâche (le salon n'est pas configuré : la publication Discord est simplement ignorée)
  r = await post('/dev/tasks', { title: 'GUI HP/Chakra', category: 'Interface', priority: 'high', _csrf: CSRF }, cookie);
  assert.ok(tasks.list().some((t) => t.title === 'GUI HP/Chakra'));
  // Élément de roadmap → 100 % passe en « Terminé »
  const cat = roadmap.categories()[0];
  r = await post('/dev/roadmap/items', { title: 'Kunai', category_id: String(cat.id), status: 'in_progress', progress: '100', _csrf: CSRF }, cookie);
  const it = roadmap.items(cat.id).find((x) => x.title === 'Kunai')!;
  assert.equal(it.status, 'done');
  // Permissions
  r = await post('/permissions', { feature: 'polls.manage', roles: role.id, _csrf: CSRF }, cookie);
  assert.deepEqual(featureRoleIds('polls.manage'), [role.id]);
  // Saisie invalide → message d'erreur, rien d'enregistré
  r = await post('/dev/tasks', { title: '', _csrf: CSRF }, cookie);
  assert.equal(r.status, 302);
  const page = await (await get('/dev/tasks', cookie)).text();
  assert.match(page, /Le titre est obligatoire/);
});

test('envois groupés : téléchargement des clés pour Roblox, et bienvenue', async () => {
  const cookie = login(OWNER);
  const id = campaigns.create({ name: 'beta-web', roleId: role.id, withKeys: true, createdBy: OWNER });
  recipients.addMissing(campaigns.get(id)!, [{ id: OWNER, tag: 'fondateur' }]);
  const page = await (await get('/massdm', cookie)).text();
  assert.match(page, /beta-web/);
  assert.match(page, /Administrateur/);
  const lua = await get(`/massdm/${id}/export.lua`, cookie);
  assert.equal(lua.status, 200);
  assert.match(lua.headers.get('content-disposition')!, /RBKSAccessKeys-beta-web\.lua/);
  assert.equal(lua.headers.get('cache-control'), 'no-store');
  assert.match(await lua.text(), /\["RBKS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}"\]/);
  assert.equal((await get(`/massdm/${id}/export.exe`, cookie)).status, 404);
  assert.equal((await get(`/massdm/${id}/export.lua`)).status, 302, 'sans connexion : refusé');
  const r = await post('/settings/welcome', { enabled: 'on', message: 'Salut {membre} !', imageUrl: '', dmMessage: 'MP', _csrf: CSRF }, cookie);
  assert.equal(r.status, 302);
  assert.equal(getSetting('welcome.message'), 'Salut {membre} !');
  assert.equal(getSetting('welcome.dmEnabled'), false);
});

test('récompenses : pages publiques de liaison et gestion des défis', async () => {
  const cookie = login(OWNER);
  const link = await get('/roblox/link?t=abc');
  assert.equal(link.status, 503, 'liaison non configurée');
  const cb = await get('/roblox/callback?error=access_denied');
  assert.equal(cb.status, 400);
  assert.match(await cb.text(), /Connexion annulée/);
  const page = await (await get('/rewards', cookie)).text();
  assert.match(page, /Relier son compte Roblox/);
  assert.match(page, /RBKSRewards/);
  let r = await post('/rewards/challenges', { title: 'Mauvais', metric: 'messages', threshold: '10', reward_label: 'X', reward_id: 'pas valide !', enabled: 'on', _csrf: CSRF }, cookie);
  assert.equal(r.status, 302);
  assert.ok(!challengesList().some((c) => c.title === 'Mauvais'));
  r = await post('/rewards/challenges', { title: 'Envoyer 50 messages', metric: 'messages', threshold: '50', reward_label: '100 Ryō', reward_id: 'ryo_100', enabled: 'on', _csrf: CSRF }, cookie);
  assert.ok(challengesList().some((c) => c.title === 'Envoyer 50 messages' && c.threshold === 50));
  const lua = await get('/rewards/RBKSRewards.server.lua', cookie);
  assert.equal(lua.status, 200);
});
