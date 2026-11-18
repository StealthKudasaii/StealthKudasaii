import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers';
import { tickets, reasons } from '../src/modules/tickets/tickets.repo';
import { renderTranscriptHtml } from '../src/modules/tickets/transcript';
import { suggestions } from '../src/modules/community/suggestions';
import { polls, parsePollOptions } from '../src/modules/community/polls';
import { getSetting, setSetting, clearSettingsCache } from '../src/core/settings';
import { featureRoleIds, setFeatureRoles, can } from '../src/core/permissions';
import { setResource } from '../src/core/resources';
import { normalizeRoadmap } from '../src/modules/dev/dev.service';
import { progressBar, normalizeName, truncate, splitLines } from '../src/core/text';
import { withLock, hitCooldown, rateLimit } from '../src/core/guards';

beforeEach(() => freshDb());

test('données initiales : 6 motifs de tickets', () => {
  assert.equal(reasons.list().length, 6);
});

test('tickets : prise en charge et fermeture atomiques', () => {
  const id = tickets.create({ userId: '1', reasonId: 1, reasonLabel: 'Q', subject: 's', details: 'd' });
  assert.equal(tickets.openCountForUser('1'), 1);
  assert.equal(tickets.claim(id, 'staff1'), true);
  assert.equal(tickets.claim(id, 'staff2'), false);
  assert.equal(tickets.markClosed(id, 'staff1', null), true);
  assert.equal(tickets.markClosed(id, 'staff2', null), false);
  assert.equal(tickets.openCountForUser('1'), 0);
});

test('transcript HTML : contenu échappé', () => {
  const id = tickets.create({ userId: '1', reasonId: 1, reasonLabel: '<b>Q</b>', subject: 's', details: 'd' });
  const html = renderTranscriptHtml(tickets.get(id)!, [{ author: '<script>', authorId: '1', avatar: 'https://x/a.png', bot: false, createdAt: Date.now(), content: '<img src=x onerror=alert(1)>', embeds: [], attachments: [] }], [], {}, 'RBKS');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x'));
});

test('suggestions : un vote par membre, modifiable', () => {
  const id = suggestions.create('1', 't', 'c');
  assert.equal(suggestions.vote(id, 'a', 1), 'added');
  assert.equal(suggestions.vote(id, 'b', -1), 'added');
  assert.equal(suggestions.vote(id, 'a', -1), 'changed');
  assert.deepEqual(suggestions.votes(id), { up: 0, down: 2 });
  assert.equal(suggestions.vote(id, 'a', -1), 'removed');
  assert.deepEqual(suggestions.votes(id), { up: 0, down: 1 });
});

test('sondages : votes et résultats', () => {
  const parsed = parsePollOptions('A\nB\nC');
  assert.ok(parsed.ok);
  const id = polls.create({ question: 'Q', options: ['A', 'B', 'C'], multi: true, anonymous: true, live: true, ends_at: null, created_by: '1' });
  polls.vote(id, 'u1', [0, 2]);
  polls.vote(id, 'u2', [2]);
  polls.vote(id, 'u1', [1]);
  assert.deepEqual(polls.results(id), { counts: [0, 1, 1], voters: 2 });
  assert.equal(polls.close(id), true);
  assert.equal(polls.close(id), false);
  assert.equal(parsePollOptions('A').ok, false);
});

test('réglages : valeurs par défaut et fusion des objets', () => {
  assert.equal(getSetting('tickets.maxOpenPerUser'), 1);
  setSetting('logs.enabled', { members: false } as Record<string, boolean>);
  clearSettingsCache();
  const l = getSetting('logs.enabled');
  assert.equal(l.members, false);
  assert.equal(l.tickets, true);
});

test('permissions : rôles par défaut puis personnalisés', () => {
  setResource('role:admin', 'role', '300000000000000003');
  setResource('role:founder', 'role', '300000000000000001');
  assert.ok(featureRoleIds('tickets.manage').includes('300000000000000003'));
  setFeatureRoles('tickets.manage', ['300000000000000009']);
  assert.deepEqual(featureRoleIds('tickets.manage'), ['300000000000000009']);
  const fakeMember = (roles: string[], admin = false) =>
    ({ id: '5', guild: { ownerId: '9' }, permissions: { has: () => admin }, roles: { cache: { some: (fn: (r: { id: string }) => boolean) => roles.some((id) => fn({ id })) } } }) as never;
  assert.equal(can(fakeMember(['300000000000000009']), 'tickets.manage'), true);
  assert.equal(can(fakeMember(['300000000000000003']), 'tickets.manage'), false);
  assert.equal(can(fakeMember([], true), 'tickets.manage'), true);
  setFeatureRoles('tickets.manage', null);
  assert.ok(featureRoleIds('tickets.manage').includes('300000000000000003'));
});

test('roadmap : normalisation statut / progression', () => {
  assert.deepEqual(normalizeRoadmap('in_progress', 100), { status: 'done', progress: 100 });
  assert.deepEqual(normalizeRoadmap('done', 40), { status: 'done', progress: 100 });
  assert.deepEqual(normalizeRoadmap('postponed', 100), { status: 'postponed', progress: 100 });
  assert.deepEqual(normalizeRoadmap('planned', 140), { status: 'done', progress: 100 });
  assert.deepEqual(normalizeRoadmap('planned', 42.4), { status: 'planned', progress: 42 });
});

test('utilitaires texte', () => {
  assert.equal(progressBar(50, 10), '▰▰▰▰▰▱▱▱▱▱ 50%');
  assert.equal(normalizeName('👑 Fondateur'), 'fondateur');
  assert.equal(normalizeName('#mises-à-jour'), 'misesajour');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.deepEqual(splitLines('- a\n\n• b\n c '), ['a', 'b', 'c']);
});

test('verrous et limites anti-abus', async () => {
  const order: number[] = [];
  await Promise.all([
    withLock('k', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    }),
    withLock('k', async () => order.push(2)),
  ]);
  assert.deepEqual(order, [1, 2]);
  assert.equal(hitCooldown('c', 1000), 0);
  assert.ok(hitCooldown('c', 1000) > 0);
  assert.equal(rateLimit('r', 2, 1000), true);
  assert.equal(rateLimit('r', 2, 1000), true);
  assert.equal(rateLimit('r', 2, 1000), false);
});
