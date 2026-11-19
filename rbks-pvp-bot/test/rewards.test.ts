import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { ChannelType, Collection } from 'discord.js';
import { freshDb } from './helpers';
import { resetEnvCache } from '../src/config/env';
import { db } from '../src/db';
import { __setClientForTests } from '../src/bot/client';
import { activity, challenges, links, unlocks } from '../src/modules/rewards/rewards.repo';
import { evaluate, metricsFor, progressFor, voiceTick } from '../src/modules/rewards/rewards.service';
import { createLinkToken, finishAuthorization, startAuthorization, writeRewardsEntry } from '../src/modules/rewards/roblox';
import { joins } from '../src/modules/welcome';
import { applications, forms } from '../src/modules/whitelist/forms.repo';
import { bugs } from '../src/modules/community/bugs';
import { suggestions } from '../src/modules/community/suggestions';
import { polls } from '../src/modules/community/polls';

const realFetch = globalThis.fetch;
beforeEach(() => {
  freshDb();
  __setClientForTests(null);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ['ROBLOX_OAUTH_CLIENT_ID', 'ROBLOX_OAUTH_CLIENT_SECRET', 'ROBLOX_OPEN_CLOUD_API_KEY', 'ROBLOX_UNIVERSE_ID']) delete process.env[k];
  resetEnvCache();
});

test('défis par défaut installés (13), chaque type mesuré', () => {
  assert.equal(challenges.list().length, 13);
  const u = 'u1';
  const f = forms.create({ name: 'f', title: 'F', description: '', button_label: 'Go', banner_url: null, review_channel_id: null, accepted_role_id: null, created_by: '1' });
  applications.decide(applications.create({ formId: f, userId: u, userTag: 'u', answers: [], roblox: null, robloxId: null }), 'accepted', 's', null);
  const b = bugs.create({ userId: u, title: 't', description: 'd', steps: '', platform: 'PC', attachments: [] });
  bugs.setStatus(b, 'resolved');
  bugs.create({ userId: u, title: 't2', description: 'd', steps: '', platform: 'PC', attachments: [] }); // non résolu : pas compté
  const s = suggestions.create(u, 't', 'c');
  suggestions.setStatus(s, 'implemented', null, 'staff');
  for (let i = 0; i < 3; i++) polls.vote(polls.create({ question: 'q', options: ['a', 'b'], multi: false, anonymous: true, live: true, ends_at: null, created_by: '1' }), u, [0]);
  for (let i = 0; i < 4; i++) activity.addMessage(u);
  activity.addVoice([u], 125);
  assert.equal(activity.addAnnouncementReaction(u, 'm1', 'c'), true);
  assert.equal(activity.addAnnouncementReaction(u, 'm1', 'c'), false, 'une seule fois par annonce');
  joins.record('friend1', { source: 'invite', code: 'x', inviterId: u });
  joins.record('friend2', { source: 'invite', code: 'x', inviterId: u });
  joins.markLeft('friend2');
  const m = metricsFor(u, null);
  assert.deepEqual(m, { linked: 0, invites: 1, beta: 1, test_sessions: 0, bugs_resolved: 1, suggestions_accepted: 1, boost: 0, voice_minutes: 2, messages: 4, polls: 3, announcement_reactions: 1 });
});

test('déblocage : une seule fois, et livraison seulement si compte relié', async () => {
  const u = 'u2';
  joins.record('f1', { source: 'invite', code: 'x', inviterId: u });
  let fresh = await evaluate(u);
  assert.deepEqual(fresh.map((c) => c.title), ['Inviter 1 ami']);
  assert.deepEqual(await evaluate(u), [], 'jamais débloqué deux fois');
  // Le filleul part : la récompense reste acquise.
  joins.markLeft('f1');
  assert.deepEqual(await evaluate(u), []);
  assert.equal(unlocks.count(u), 1);
  links.save(u, { id: '123456', username: 'Shinobi_42', displayName: 'Shinobi' });
  fresh = await evaluate(u);
  assert.deepEqual(fresh.map((c) => c.metric), ['linked']);
  assert.deepEqual(unlocks.rewardIds(u), ['ryo_500', 'title_genin']);
  assert.equal(links.get(u)!.needs_sync, 1, 'livraison en attente (Open Cloud non configuré)');
  // Désactiver un défi le retire de la liste livrée au jeu.
  const c = challenges.list().find((x) => x.reward_id === 'ryo_500')!;
  challenges.update(c.id, { ...c, enabled: false });
  assert.deepEqual(unlocks.rewardIds(u), ['title_genin']);
  const p = progressFor(u, null);
  assert.ok(p.every((x) => x.challenge.enabled));
});

test('un compte Roblox ne peut être relié qu’à un seul Discord', () => {
  links.save('a', { id: '999', username: 'X', displayName: null });
  assert.throws(() => links.save('b', { id: '999', username: 'X', displayName: null }), /UNIQUE/);
});

test('vocal : compté seulement en conversation (pas seul, pas en sourdine casque, pas AFK)', () => {
  const m = (id: string, deaf = false, bot = false) => [id, { id, user: { bot }, voice: { deaf } }] as const;
  const vc = (id: string, members: ReturnType<typeof m>[]) => [id, { id, type: ChannelType.GuildVoice, members: new Collection(members) }] as const;
  __setClientForTests({
    guilds: {
      cache: new Collection([
        [
          process.env.GUILD_ID!,
          {
            id: process.env.GUILD_ID!,
            afkChannelId: 'afk',
            channels: {
              cache: new Collection([
                vc('v1', [m('talk1'), m('talk2'), m('deaf', true), m('bot', false, true)]),
                vc('v2', [m('alone'), m('bot2', false, true)]),
                vc('afk', [m('afk1'), m('afk2')]),
                ['t', { id: 't', type: ChannelType.GuildText }],
              ]),
            },
          },
        ],
      ]),
    },
  });
  voiceTick(60);
  const secs = (id: string) => activity.get(id).voice_seconds;
  assert.equal(secs('talk1'), 60);
  assert.equal(secs('talk2'), 60);
  assert.equal(secs('deaf'), 0);
  assert.equal(secs('alone'), 0);
  assert.equal(secs('afk1'), 0);
});

test('liaison Roblox : lien à usage unique, PKCE, profil lu', async () => {
  process.env.ROBLOX_OAUTH_CLIENT_ID = 'client-id';
  process.env.ROBLOX_OAUTH_CLIENT_SECRET = 'client-secret';
  resetEnvCache();
  const token = createLinkToken('discord-1');
  const url = new URL(startAuthorization(token)!);
  assert.equal(url.origin + url.pathname, 'https://apis.roblox.com/oauth/v1/authorize');
  assert.equal(url.searchParams.get('scope'), 'openid profile');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3000/roblox/callback');
  assert.equal(startAuthorization(token), null, 'le lien ne sert qu’une fois');
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
    calls.push({ url: String(u), init });
    if (String(u).endsWith('/token')) return new Response(JSON.stringify({ access_token: 'at' }), { status: 200 });
    return new Response(JSON.stringify({ sub: '424242', preferred_username: 'Shinobi_42', name: 'Shinobi' }), { status: 200 });
  }) as typeof fetch;
  const state = url.searchParams.get('state')!;
  const res = await finishAuthorization(state, 'the-code');
  assert.deepEqual(res, { discordId: 'discord-1', profile: { id: '424242', username: 'Shinobi_42', displayName: 'Shinobi' } });
  const body = new URLSearchParams(String(calls[0].init!.body));
  // Le vérificateur PKCE envoyé correspond au défi de l'URL d'autorisation.
  assert.equal(crypto.createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(body.get('code'), 'the-code');
  await assert.rejects(finishAuthorization(state, 'the-code'), /expiré/, 'state à usage unique');
});

test('Open Cloud : écriture du DataStore au bon format', async () => {
  process.env.ROBLOX_OPEN_CLOUD_API_KEY = 'key';
  process.env.ROBLOX_UNIVERSE_ID = '777';
  resetEnvCache();
  let req: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
    req = { url: String(u), init: init! };
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  await writeRewardsEntry({ discordId: 'd', robloxId: '424242', rewards: ['title_genin'], updatedAt: 'now' });
  const r = req!;
  const u = new URL(r.url);
  assert.equal(u.pathname, '/datastores/v1/universes/777/standard-datastores/datastore/entries/entry');
  assert.equal(u.searchParams.get('datastoreName'), 'RBKSRewards');
  assert.equal(u.searchParams.get('entryKey'), '424242');
  const h = r.init.headers as Record<string, string>;
  assert.equal(h['x-api-key'], 'key');
  assert.equal(h['content-md5'], crypto.createHash('md5').update(String(r.init.body)).digest('base64'));
  assert.equal(h['roblox-entry-userids'], '[424242]');
  assert.deepEqual(JSON.parse(String(r.init.body)).rewards, ['title_genin']);
  globalThis.fetch = (async () => new Response('', { status: 403 })) as typeof fetch;
  await assert.rejects(writeRewardsEntry({ discordId: 'd', robloxId: '1', rewards: [], updatedAt: 'now' }), /droits/);
});

test('script Roblox livré (ASCII, table REWARDS, DataStore et sujet)', () => {
  const lua = fs.readFileSync(require('node:path').join(__dirname, '..', 'deploy', 'roblox', 'RBKSRewards.server.lua'), 'utf8');
  assert.ok(/^[\x00-\x7F]*$/.test(lua));
  assert.ok(lua.includes('GetDataStore("RBKSRewards")'));
  assert.ok(lua.includes('local TOPIC = "RBKSRewards"'));
  assert.ok(lua.includes('local REWARDS = {'));
  void db;
});
