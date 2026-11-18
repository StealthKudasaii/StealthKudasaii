import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers';
import { applications, drafts, forms, questions } from '../src/modules/whitelist/forms.repo';
import { BETA_TEMPLATE, formState, pages, parseQuestionInput, snapshotAnswers, validateAnswers } from '../src/modules/whitelist/forms.logic';
import { buildPageModal, formPublicPayload, reviewButtons } from '../src/modules/whitelist/forms.service';
import { builderPayload, infoModal } from '../src/modules/whitelist/builder';

beforeEach(() => freshDb());

function makeForm() {
  const id = forms.create({ name: 'beta-1', title: 'RBKS PVP — Candidature Bêta-Test', description: 'desc', button_label: 'Postuler', banner_url: null, review_channel_id: null, accepted_role_id: null, created_by: '1' });
  for (const q of BETA_TEMPLATE) questions.create(id, q);
  return forms.get(id)!;
}

test('le modèle bêta se découpe en étapes de 5 questions max', () => {
  const f = makeForm();
  const qs = questions.list(f.id);
  assert.equal(qs.length, 7);
  const pg = pages(qs);
  assert.deepEqual(pg.map((p) => p.length), [5, 2]);
  // Les fenêtres générées respectent les limites Discord (validées par discord.js).
  pg.forEach((p, i) => assert.doesNotThrow(() => buildPageModal(f, p, i, pg.length, {}).toJSON()));
});

test('pré-remplissage d’une étape après erreur', () => {
  const f = makeForm();
  const qs = questions.list(f.id);
  const modal = buildPageModal(f, pages(qs)[0], 0, 2, { [qs[0].id]: 'Shinobi_42', [qs[2].id]: ['1'] }).toJSON() as any;
  const first = modal.components[0];
  assert.equal(first.component.value, 'Shinobi_42');
  const select = modal.components[2].component;
  assert.equal(select.options.find((o: any) => o.value === '1').default, true);
});

test('validation des réponses', () => {
  const f = makeForm();
  const qs = questions.list(f.id);
  const [roblox, , platform, why] = qs;
  const errs = validateAnswers(qs, { [roblox.id]: 'a b', [platform.id]: ['9'], [why.id]: '' });
  assert.ok(errs.some((e) => e.includes('pseudo Roblox invalide')));
  assert.ok(errs.some((e) => e.includes('choix invalide')));
  assert.ok(errs.some((e) => e.includes('obligatoire')));
  const ok = validateAnswers([roblox, platform], { [roblox.id]: 'Shinobi_42', [platform.id]: ['0'] });
  assert.deepEqual(ok, []);
  const snap = snapshotAnswers([roblox, platform], { [roblox.id]: ' Shinobi_42 ', [platform.id]: ['0'] });
  assert.equal(snap[0].value, 'Shinobi_42');
  assert.equal(snap[1].value, 'PC');
});

test('question numérique avec plage', () => {
  const parsed = parseQuestionInput({ label: 'Âge', type: 'number', required: true, range: '13-99' });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const f = makeForm();
  const id = questions.create(f.id, parsed.value);
  const q = questions.get(id)!;
  assert.deepEqual(validateAnswers([q], { [id]: '12' }), ['« Âge » doit être supérieur ou égal à 13.']);
  assert.deepEqual(validateAnswers([q], { [id]: '20' }), []);
  assert.equal(parseQuestionInput({ label: 'x'.repeat(46), type: 'short', required: true }).ok, false);
  assert.equal(parseQuestionInput({ label: 'Choix', type: 'single', required: true, choices: 'A' }).ok, false);
});

test('états du formulaire (dates, complet, brouillon)', () => {
  const now = Date.now();
  assert.equal(formState({ status: 'draft', opens_at: null, closes_at: null, max_applications: null }, 0), 'draft');
  assert.equal(formState({ status: 'open', opens_at: now + 1e6, closes_at: null, max_applications: null }, 0), 'scheduled');
  assert.equal(formState({ status: 'open', opens_at: null, closes_at: now - 1, max_applications: null }, 0), 'ended');
  assert.equal(formState({ status: 'open', opens_at: null, closes_at: null, max_applications: 2 }, 2), 'full');
  assert.equal(formState({ status: 'open', opens_at: null, closes_at: null, max_applications: 2 }, 1), 'open');
});

test('une seule candidature active par membre (contrainte en base)', () => {
  const f = makeForm();
  applications.create({ formId: f.id, userId: '42', userTag: 'a', answers: [], roblox: null, robloxId: null });
  assert.throws(() => applications.create({ formId: f.id, userId: '42', userTag: 'a', answers: [], roblox: null, robloxId: null }), /UNIQUE/);
});

test('une décision ne peut être prise qu’une fois', () => {
  const f = makeForm();
  const id = applications.create({ formId: f.id, userId: '42', userTag: 'a', answers: [], roblox: null, robloxId: null });
  assert.equal(applications.decide(id, 'on_hold', 's1', null), true);
  assert.equal(applications.decide(id, 'on_hold', 's1', null), false);
  assert.equal(applications.decide(id, 'accepted', 's1', null), true);
  assert.equal(applications.decide(id, 'refused', 's2', 'trop tard'), false);
  assert.equal(applications.get(id)!.status, 'accepted');
  // Après acceptation, une nouvelle candidature redevient possible côté base (bloquée par canApply).
  assert.doesNotThrow(() => applications.create({ formId: f.id, userId: '42', userTag: 'a', answers: [], roblox: null, robloxId: null }));
  const s = applications.stats(f.id);
  assert.equal(s.accepted, 1);
  assert.equal(s.pending, 1);
});

test('déplacement et suppression de questions', () => {
  const f = makeForm();
  let qs = questions.list(f.id);
  questions.move(qs[1].id, -1);
  assert.equal(questions.list(f.id)[0].id, qs[1].id);
  questions.remove(qs[0].id);
  qs = questions.list(f.id);
  assert.deepEqual(qs.map((q) => q.position), [1, 2, 3, 4, 5, 6]);
});

test('brouillons', () => {
  const f = makeForm();
  drafts.save('7', f.id, { a: 'b' });
  assert.deepEqual(drafts.get('7', f.id), { a: 'b' });
  drafts.clear('7', f.id);
  assert.deepEqual(drafts.get('7', f.id), {});
});

test('composants Discord valides (assistant, publication, examen)', () => {
  const f = makeForm();
  assert.doesNotThrow(() => infoModal().toJSON());
  assert.doesNotThrow(() => infoModal(f).toJSON());
  assert.doesNotThrow(() => builderPayload(f).components.forEach((c) => c.toJSON()));
  const pub = formPublicPayload(f);
  assert.doesNotThrow(() => pub.components.forEach((c) => c.toJSON()));
  const id = applications.create({ formId: f.id, userId: '42', userTag: 'a', answers: [], roblox: null, robloxId: null });
  assert.doesNotThrow(() => reviewButtons(applications.get(id)!).forEach((c) => c.toJSON()));
});
