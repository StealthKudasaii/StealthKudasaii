import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers';
import { campaigns, recipients, generateKey, KEY_RE } from '../src/modules/massdm/massdm.repo';
import { dmEmbed, exportCsv, exportJson, exportLua, renderText } from '../src/modules/massdm/massdm.service';
import { detectInvite, joins, renderWelcome, welcomeEmbed } from '../src/modules/welcome';
import { applications, forms } from '../src/modules/whitelist/forms.repo';

beforeEach(() => freshDb());

test('clés : format lisible, sans caractères ambigus, uniques', () => {
  const keys = new Set<string>();
  for (let i = 0; i < 5000; i++) {
    const k = generateKey();
    assert.match(k, KEY_RE);
    assert.ok(!/[01ILO]/.test(k.slice(5)), k);
    keys.add(k);
  }
  assert.equal(keys.size, 5000);
});

test('lot : une clé par membre, jamais modifiée quand on relance', () => {
  const id = campaigns.create({ name: 'beta-1', roleId: '600000000000000001', withKeys: true, createdBy: '1' });
  const c = campaigns.get(id)!;
  assert.equal(recipients.addMissing(c, [{ id: 'u1', tag: 'a' }, { id: 'u2', tag: 'b' }]), 2);
  const first = Object.fromEntries(recipients.list(id).map((r) => [r.user_id, r.access_key]));
  assert.match(first.u1!, KEY_RE);
  assert.notEqual(first.u1, first.u2);
  // Un nouveau testeur arrive : seul lui est ajouté, les clés existantes ne changent pas.
  assert.equal(recipients.addMissing(c, [{ id: 'u1', tag: 'a' }, { id: 'u2', tag: 'b' }, { id: 'u3', tag: 'c' }]), 1);
  const after = Object.fromEntries(recipients.list(id).map((r) => [r.user_id, r.access_key]));
  assert.equal(after.u1, first.u1);
  assert.equal(after.u2, first.u2);
  recipients.markSent(id, 'u1');
  recipients.markFailed(id, 'u2', 'messages privés fermés');
  assert.deepEqual(campaigns.counts(id), { total: 3, pending: 1, sent: 1, failed: 1 });
  assert.equal(recipients.retryFailed(id), 1);
  assert.deepEqual(campaigns.counts(id), { total: 3, pending: 2, sent: 1, failed: 0 });
  assert.equal(recipients.keysForUser('u1')[0].access_key, first.u1);
  // Un lot sans clés
  const id2 = campaigns.create({ name: 'annonce', roleId: '600000000000000001', withKeys: false, createdBy: '1' });
  recipients.addMissing(campaigns.get(id2)!, [{ id: 'u1', tag: 'a' }]);
  assert.equal(recipients.list(id2)[0].access_key, null);
});

test('message : variables remplacées et clé affichée', () => {
  const id = campaigns.create({ name: 'beta-2', roleId: '600000000000000001', withKeys: true, createdBy: '1' });
  campaigns.setMessage(id, '🧪 Accès bêta', 'Salut {pseudo} ({membre}) ! Ta clé : {cle} — Roblox : {roblox} — {serveur} @everyone');
  const c = campaigns.get(id)!;
  const text = renderText(c.message, { userId: '42', displayName: 'Naruto', key: 'RBKS-AAAA-BBBB-CCCC', roblox: 'Shinobi_42' });
  assert.equal(text, 'Salut Naruto (<@42>) ! Ta clé : `RBKS-AAAA-BBBB-CCCC` — Roblox : Shinobi_42 — RBKS PVP @everyone');
  const e = dmEmbed(c, { userId: '42', displayName: 'Naruto', key: 'RBKS-AAAA-BBBB-CCCC', roblox: null });
  assert.doesNotThrow(() => e.toJSON());
  assert.ok(!e.data.description!.includes('@everyone'), 'mentions de masse neutralisées');
  assert.ok(e.data.fields!.some((f) => f.value.includes('RBKS-AAAA-BBBB-CCCC')));
});

test('exports : Lua (ServerStorage), CSV et JSON avec le pseudo Roblox des candidatures', () => {
  const f = forms.create({ name: 'f', title: 'F', description: '', button_label: 'Go', banner_url: null, review_channel_id: null, accepted_role_id: null, created_by: '1' });
  const a = applications.create({ formId: f, userId: 'u1', userTag: 'naruto', answers: [], roblox: 'Shinobi_42', robloxId: null });
  applications.decide(a, 'accepted', 's', null);
  const id = campaigns.create({ name: 'beta "1"', roleId: '600000000000000001', withKeys: true, createdBy: '1' });
  recipients.addMissing(campaigns.get(id)!, [{ id: 'u1', tag: 'naruto' }, { id: 'u2', tag: 'sasu"ke\\' }]);
  const key1 = recipients.list(id).find((r) => r.user_id === 'u1')!.access_key!;
  const lua = exportLua(id);
  assert.ok(lua.includes(`["${key1}"] = "u1", -- naruto / Roblox : Shinobi_42`));
  assert.ok(lua.includes('lot "beta \\"1\\""'), 'guillemets échappés');
  assert.ok(lua.trimEnd().endsWith('}'));
  assert.equal((lua.match(/\["RBKS-/g) ?? []).length, 2);
  const csv = exportCsv(id).trim().split('\n');
  assert.equal(csv[0], 'cle,discord_id,discord_pseudo,roblox,statut_envoi');
  assert.equal(csv.length, 3);
  assert.ok(csv.some((l) => l.includes('"sasu""ke\\"')));
  const json = JSON.parse(exportJson(id));
  assert.equal(json.keys.length, 2);
  assert.equal(json.keys.find((k: { discordId: string }) => k.discordId === 'u1').roblox, 'Shinobi_42');
});

test('invitations : détection du lien utilisé', () => {
  const before = new Map([
    ['abc', { uses: 3, inviterId: 'p1' }],
    ['def', { uses: 0, inviterId: 'p2' }],
    ['once', { uses: 0, inviterId: 'p3' }],
  ]);
  // Lien classique
  assert.deepEqual(detectInvite(before, [{ code: 'abc', uses: 4, inviterId: 'p1' }, { code: 'def', uses: 0, inviterId: 'p2' }, { code: 'once', uses: 0, inviterId: 'p3' }], null, null), { source: 'invite', code: 'abc', inviterId: 'p1' });
  // Lien à usage unique qui a disparu après usage
  assert.deepEqual(detectInvite(before, [{ code: 'abc', uses: 3, inviterId: 'p1' }, { code: 'def', uses: 0, inviterId: 'p2' }], null, null), { source: 'invite', code: 'once', inviterId: 'p3' });
  // Lien personnalisé du serveur
  assert.equal(detectInvite(before, [{ code: 'abc', uses: 3, inviterId: 'p1' }, { code: 'def', uses: 0, inviterId: 'p2' }, { code: 'once', uses: 0, inviterId: 'p3' }], 10, 11).source, 'vanity');
  // Ambigu (deux liens ont augmenté) : inconnu plutôt qu'un faux parrain
  assert.equal(detectInvite(before, [{ code: 'abc', uses: 4, inviterId: 'p1' }, { code: 'def', uses: 1, inviterId: 'p2' }, { code: 'once', uses: 0, inviterId: 'p3' }], null, null).source, 'unknown');
  // Nouveau lien créé pendant que le bot était hors ligne puis utilisé
  assert.deepEqual(detectInvite(before, [{ code: 'abc', uses: 3, inviterId: 'p1' }, { code: 'def', uses: 0, inviterId: 'p2' }, { code: 'once', uses: 0, inviterId: 'p3' }, { code: 'new', uses: 1, inviterId: 'p4' }], null, null).inviterId, 'p4');
});

test('invitations : départs et retours ne comptent pas double', () => {
  const inv = (inviterId: string) => ({ source: 'invite' as const, code: 'x', inviterId });
  joins.record('a', inv('p1'));
  joins.record('b', inv('p1'));
  joins.record('c', inv('p2'));
  joins.record('p1', inv('p1')); // s'inviter soi-même ne compte pas
  assert.deepEqual(joins.statsFor('p1'), { total: 2, active: 2, left: 0 });
  joins.markLeft('b');
  assert.deepEqual(joins.statsFor('p1'), { total: 2, active: 1, left: 1 });
  // b revient via p2 : il ne compte plus pour p1
  joins.record('b', inv('p2'));
  assert.deepEqual(joins.statsFor('p1'), { total: 1, active: 1, left: 0 });
  assert.deepEqual(joins.statsFor('p2'), { total: 2, active: 2, left: 0 });
  const top = joins.top();
  assert.equal(top[0].inviter_id, 'p2');
  assert.equal(joins.inviterOf('b')!.inviterId, 'p2');
});

test('bienvenue : variables et embed valide', () => {
  const ctx = { userId: '42', displayName: 'Naruto', memberCount: 128, join: { source: 'invite' as const, code: 'abc', inviterId: '7' }, inviterInvites: 5 };
  const text = renderWelcome('Bienvenue {membre} ({pseudo}) ! {nombre}ᵉ membre de {serveur}, invité par {invitepar} ({invitations}). {regles}', ctx);
  assert.equal(text, 'Bienvenue <@42> (Naruto) ! 128ᵉ membre de RBKS PVP, invité par <@7> (5). #règlement');
  const e = welcomeEmbed(ctx, 'https://cdn.discordapp.com/embed/avatars/0.png');
  assert.doesNotThrow(() => e.toJSON());
  assert.ok(e.data.fields!.some((f) => f.name === 'Invité par'));
});
