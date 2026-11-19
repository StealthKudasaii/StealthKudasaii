import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers';
import { challenges, links, parseChallenge, slugifyRewardId, METRICS, type Metric } from '../src/modules/rewards/rewards.repo';
import { challengeModal, detailPayload, listPayload } from '../src/modules/rewards/admin';

beforeEach(() => freshDb());

test('identifiant pour le jeu généré depuis la récompense', () => {
  assert.equal(slugifyRewardId('Skin Katon exclusif !'), 'skin_katon_exclusif');
  assert.equal(slugifyRewardId('Titre « Genin »'), 'titre_genin');
  assert.equal(slugifyRewardId('???'), 'recompense');
});

test('validation d’un défi', () => {
  const ok = parseChallenge({ metric: 'messages', title: 'Envoyer 500 messages', rewardLabel: 'Skin Katon', threshold: '500' });
  assert.ok(ok.ok && ok.value.reward_id === 'skin_katon' && ok.value.threshold === 500);
  const binary = parseChallenge({ metric: 'boost', title: 'Booster', rewardLabel: 'Aura', threshold: '999' });
  assert.ok(binary.ok && binary.value.threshold === 1, 'oui/non : seuil forcé à 1');
  assert.equal(parseChallenge({ metric: 'messages', title: 'X', rewardLabel: 'Y', threshold: 'beaucoup' }).ok, false);
  assert.equal(parseChallenge({ metric: 'messages', title: 'X', rewardLabel: 'Y', threshold: '0' }).ok, false);
  assert.equal(parseChallenge({ metric: 'messages', title: 'X', rewardLabel: 'Y', threshold: '5', rewardId: 'pas valide !' }).ok, false);
  assert.equal(parseChallenge({ metric: 'inconnu', title: 'X', rewardLabel: 'Y' }).ok, false);
  assert.equal(parseChallenge({ metric: 'messages', title: '', rewardLabel: 'Y', threshold: '5' }).ok, false);
});

test('déplacer, désactiver, tout supprimer', () => {
  const list = challenges.list();
  assert.equal(list.length, 13);
  challenges.move(list[2].id, -1);
  assert.equal(challenges.list()[1].id, list[2].id);
  challenges.move(list[0].id, -1); // déjà en haut : rien
  assert.equal(challenges.list()[0].id, list[0].id);
  challenges.setEnabled(list[0].id, false);
  assert.equal(challenges.list(true).length, 12);
  links.save('d', { id: '1', username: 'A', displayName: null });
  links.markSynced('d');
  assert.equal(challenges.removeAll(), 13);
  assert.equal(challenges.list().length, 0);
  assert.equal(challenges.nextPosition(), 1);
});

test('panneau /rewardsconfig valide pour Discord (liste vide, pleine, détail, fenêtres)', () => {
  const json = (x: { toJSON(): unknown }) => assert.doesNotThrow(() => x.toJSON());
  let p = listPayload();
  p.embeds.forEach(json);
  p.components.forEach(json);
  const c = challenges.list()[0];
  const d = detailPayload(c, 'ok');
  d.embeds.forEach(json);
  d.components.forEach(json);
  for (const metric of Object.keys(METRICS) as Metric[]) json(challengeModal(metric));
  json(challengeModal(c.metric, c));
  // 30 défis : la liste reste dans les limites (menu de 25 options, texte ≤ 4096).
  for (let i = 0; i < 17; i++) challenges.create({ title: `Défi ${i} avec un nom assez long pour tester`, description: '', metric: 'messages', threshold: 10 + i, reward_id: `r_${i}`, reward_label: 'Une récompense au nom plutôt long elle aussi', emoji: null, position: 20 + i, enabled: true });
  p = listPayload();
  p.embeds.forEach(json);
  p.components.forEach(json);
  challenges.removeAll();
  p = listPayload();
  assert.equal(p.components.length, 2, 'sans défi : pas de menu « gérer »');
  p.components.forEach(json);
});
