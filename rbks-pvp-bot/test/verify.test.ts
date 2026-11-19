import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers';
import { links, unlocks } from '../src/modules/rewards/rewards.repo';
import {
  PHRASE_WORDS,
  cancelVerification,
  completeLink,
  descriptionHasPhrase,
  fetchRobloxProfile,
  generatePhrase,
  getVerification,
  lookupRobloxUser,
  startVerification,
} from '../src/modules/rewards/verify';

const realFetch = globalThis.fetch;
beforeEach(() => freshDb());
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('phrase : 5 mots, sans chiffres (filtre Roblox)', () => {
  for (let i = 0; i < 200; i++) {
    const p = generatePhrase();
    assert.equal(p.split(' ').length, PHRASE_WORDS);
    assert.ok(/^[a-z ]+$/.test(p), p);
  }
});

test('lecture de la description tolérante', () => {
  const phrase = 'katon lotus tonnerre dojo kunai';
  assert.ok(descriptionHasPhrase('Salut ! Katon  LOTUS tonnerre\ndojo kunai — fan de RBKS', phrase));
  assert.ok(descriptionHasPhrase('katon lotus tonnerre dojo kunai', 'katon lotus tonnerre dojo kunai'));
  assert.ok(!descriptionHasPhrase('katon lotus #### dojo kunai', phrase), 'mot filtré par Roblox');
  assert.ok(!descriptionHasPhrase('', phrase));
});

test('API Roblox : recherche par nom et lecture du profil', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(u)}`);
    if (String(u).endsWith('/usernames/users')) {
      const body = JSON.parse(String(init!.body));
      return new Response(JSON.stringify({ data: body.usernames[0] === 'Shinobi_42' ? [{ id: 4242, name: 'Shinobi_42', displayName: 'Shinobi' }] : [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 4242, name: 'Shinobi_42', displayName: 'Shinobi', description: 'katon lotus' }), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await lookupRobloxUser('Shinobi_42'), { id: '4242', username: 'Shinobi_42', displayName: 'Shinobi' });
  assert.equal(await lookupRobloxUser('Inconnu'), null);
  assert.equal((await fetchRobloxProfile('4242')).description, 'katon lotus');
  assert.ok(calls.includes('POST https://users.roblox.com/v1/usernames/users'));
  assert.ok(calls.includes('GET https://users.roblox.com/v1/users/4242'));
  globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch;
  await assert.rejects(lookupRobloxUser('Shinobi_42'), /ne répond pas/);
});

test('vérification : même phrase si on relance pour le même compte', () => {
  const p = { id: '1', username: 'A', displayName: null };
  const v1 = startVerification('d1', p);
  assert.equal(startVerification('d1', p).phrase, v1.phrase);
  // Un autre compte Roblox remplace la vérification en cours.
  assert.equal(startVerification('d1', { ...p, id: '2' }).profile.id, '2');
  assert.ok(getVerification('d1'));
  cancelVerification('d1');
  assert.equal(getVerification('d1'), null);
});

test('liaison : un compte Roblox par Discord, récompense « compte relié » débloquée', async () => {
  const p = { id: '4242', username: 'Shinobi_42', displayName: 'Shinobi' };
  assert.equal(await completeLink('d1', p, 'test'), null);
  assert.equal(links.get('d1')!.roblox_username, 'Shinobi_42');
  assert.ok(unlocks.rewardIds('d1').includes('title_genin'));
  assert.match((await completeLink('d2', p, 'test'))!, /déjà relié à un autre compte Discord/);
  assert.match((await completeLink('d1', { id: '9', username: 'Autre', displayName: null }, 'test'))!, /déjà relié au compte Roblox Shinobi_42/);
  assert.equal(await completeLink('d1', p, 'test'), null, 'relier à nouveau le même compte est sans effet');
});
