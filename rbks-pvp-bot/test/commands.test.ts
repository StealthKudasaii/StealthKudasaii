import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandsJson } from '../src/bot';
import { allCommands } from '../src/bot/registry';

test('toutes les commandes slash sont valides pour Discord', () => {
  const json = commandsJson(); // toJSON() valide noms, descriptions et options
  assert.ok(json.length > 20);
  assert.ok(json.length <= 100, 'Discord limite à 100 commandes par serveur');
  const names = new Set<string>();
  for (const c of json) {
    assert.match(c.name, /^[a-z0-9_-]{1,32}$/);
    assert.ok(!names.has(c.name), `doublon ${c.name}`);
    names.add(c.name);
    assert.ok(c.description.length <= 100);
    assert.ok((c.options ?? []).length <= 25);
  }
  for (const expected of ['setup', 'help', 'ping', 'botinfo', 'stats', 'ticket', 'wlcreate', 'wledit', 'wldelete', 'wllist', 'wlopen', 'wlclose', 'wlstats', 'wlreview', 'roadmap', 'release', 'todo', 'suggestion', 'bugreport', 'bugs', 'patchnote', 'announcement', 'notifications', 'testsession', 'poll', 'permissions', 'massdm', 'macle', 'invites']) {
    assert.ok(names.has(expected), `commande manquante : /${expected}`);
  }
  // Chaque commande documente son usage pour /help.
  for (const c of allCommands()) assert.ok(c.help.length > 0, c.data.name);
});
