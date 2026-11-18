import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, parseDuration, toInputValue, formatDate } from '../src/core/time';

test('parseDate : formats français et ISO, fuseau Europe/Paris', () => {
  // Hiver : UTC+1
  assert.equal(parseDate('25/12/2026 18:30'), Date.UTC(2026, 11, 25, 17, 30));
  // Été : UTC+2
  assert.equal(parseDate('01/07/2026 12:00'), Date.UTC(2026, 6, 1, 10, 0));
  assert.equal(parseDate('2026-07-01T12:00'), Date.UTC(2026, 6, 1, 10, 0));
  assert.equal(parseDate('25-12-2026 18h30'), Date.UTC(2026, 11, 25, 17, 30));
  assert.equal(parseDate('25/12/2026'), Date.UTC(2026, 11, 24, 23, 0));
});

test('parseDate : refuse les dates invalides', () => {
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate('12/13/2026'), null);
  assert.equal(parseDate('demain'), null);
  assert.equal(parseDate(''), null);
  assert.equal(parseDate('10/10/2026 25:00'), null);
});

test('parseDuration', () => {
  assert.equal(parseDuration('30m'), 30 * 6e4);
  assert.equal(parseDuration('2h'), 2 * 36e5);
  assert.equal(parseDuration('1h30'), 90 * 6e4);
  assert.equal(parseDuration('3j'), 3 * 864e5);
  assert.equal(parseDuration('1w'), 7 * 864e5);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration('0m'), null);
});

test('aller-retour datetime-local', () => {
  const ts = parseDate('2026-03-29T03:30')!; // jour du passage à l'heure d'été
  assert.ok(ts);
  const t2 = parseDate('2026-11-18T09:05')!;
  assert.equal(toInputValue(t2), '2026-11-18T09:05');
  assert.match(formatDate(t2), /18\/11\/2026/);
});
