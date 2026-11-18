import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers';
import { ticketEmbed, ticketPanelPayload } from '../src/modules/tickets/tickets.service';
import { tickets } from '../src/modules/tickets/tickets.repo';
import { newModal, suggestionPayload, suggestions } from '../src/modules/community/suggestions';
import { bugPayload, bugs, reportModal } from '../src/modules/community/bugs';
import { pollPayload, polls } from '../src/modules/community/polls';
import { versions, tasks, roadmap } from '../src/modules/dev/dev.repo';
import { roadmapCategoryEmbed, roadmapHeaderEmbed, taskButtons, taskEmbed, versionEmbed } from '../src/modules/dev/dev.service';
import { versionModal } from '../src/modules/dev/index';
import { announcementModal, patchnoteModal, publicationEmbed, publications } from '../src/modules/publications';
import { forms, questions, applications } from '../src/modules/whitelist/forms.repo';
import { channelsModal, questionModal, questionPayload, settingsModal } from '../src/modules/whitelist/builder';
import { reviewEmbed } from '../src/modules/whitelist/forms.service';
import { QUESTION_TYPES, type QuestionType } from '../src/config/constants';

beforeEach(() => freshDb());

const json = (x: { toJSON(): unknown }) => assert.doesNotThrow(() => x.toJSON());
const rows = (list: { toJSON(): unknown }[]) => list.forEach(json);

test('tickets : panneau et embed', () => {
  const p = ticketPanelPayload();
  p.embeds.forEach(json);
  rows(p.components);
  const id = tickets.create({ userId: '1', reasonId: 1, reasonLabel: 'Question', subject: 'x'.repeat(100), details: 'y'.repeat(1500) });
  json(ticketEmbed(tickets.get(id)!, null));
});

test('suggestions, bugs, sondages', () => {
  json(newModal());
  json(reportModal());
  const s = suggestions.create('1', 'Mode 2v2', 'Ajouter un mode 2v2');
  const sp = suggestionPayload(suggestions.get(s)!);
  sp.embeds.forEach(json);
  rows(sp.components);
  const b = bugs.create({ userId: '1', title: 'Raiton', description: 'd', steps: 's', platform: 'PC', attachments: [] });
  const bp = bugPayload(bugs.get(b)!);
  bp.embeds.forEach(json);
  rows(bp.components);
  const opts = Array.from({ length: 20 }, (_, i) => `Option ${i + 1}`);
  const pid = polls.create({ question: 'Q ?', options: opts, multi: true, anonymous: false, live: true, ends_at: Date.now() + 1e6, created_by: '1' });
  const pp = pollPayload(polls.get(pid)!);
  pp.embeds.forEach(json);
  rows(pp.components);
});

test('développement : versions, tâches, roadmap', () => {
  json(versionModal('ver:save:new::'));
  const v = versions.create({ version: 'V0.1', name: 'Combat System', description: 'Base du combat', features: ['[x] Combo', 'Garde'], status: 'in_progress', target_date: Date.now(), progress: 40 });
  json(versionEmbed(versions.get(v)!));
  json(versionModal('ver:save:1::', { ...versions.get(v)!, features: ['[x] Combo', 'Garde'] }));
  const t = tasks.create({ title: 'Lobby', description: '', category: 'Map', priority: 'high', assignee_id: null, due_date: Date.now() - 1000, created_by: '1' });
  json(taskEmbed(tasks.get(t)!));
  rows(taskButtons(tasks.get(t)!));
  tasks.update(t, { status: 'done', completed_at: Date.now() });
  rows(taskButtons(tasks.get(t)!));
  const cat = roadmap.categories()[0];
  for (let i = 0; i < 40; i++) roadmap.createItem({ category_id: cat.id, title: `Fonction ${i}`, description: 'z'.repeat(400), status: 'planned', progress: i, target_date: null });
  json(roadmapHeaderEmbed());
  const e = roadmapCategoryEmbed(cat.id);
  json(e);
  assert.ok((e.data.description ?? '').length <= 4096);
});

test('publications', () => {
  json(patchnoteModal('pub:save:patchnote:new:V1::1:'));
  json(announcementModal('pub:save:announcement:new:::0:'));
  const id = publications.create({ kind: 'patchnote', version: 'V0.2', title: 'Raiton', description: 'd', features: 'a\nb', fixes: 'c', balance: 'd', image_url: null, publish_date: Date.now(), ping: true }, '1');
  json(publicationEmbed(publications.get(id)!));
});

test('assistant de formulaire : toutes les fenêtres de configuration', () => {
  const f = forms.create({ name: 'x', title: 'X', description: '', button_label: 'Go', banner_url: null, review_channel_id: null, accepted_role_id: null, created_by: '1' });
  const form = forms.get(f)!;
  json(channelsModal(form));
  json(settingsModal(form));
  for (const type of Object.keys(QUESTION_TYPES) as QuestionType[]) json(questionModal(f, type));
  const qid = questions.create(f, { label: 'Plateforme', type: 'single', required: true, choices: ['PC', 'Mobile'] });
  json(questionModal(f, 'single', questions.get(qid)));
  const qp = questionPayload(questions.get(qid)!);
  qp.embeds.forEach(json);
  rows(qp.components);
  const long = Array.from({ length: 25 }, (_, i) => ({ qid: i, label: `Question ${i}`, type: 'long' as const, value: 'w'.repeat(1500) }));
  const aid = applications.create({ formId: f, userId: '9', userTag: 'u', answers: long, roblox: 'Shinobi', robloxId: '123' });
  const e = reviewEmbed(applications.get(aid)!, null, true);
  json(e);
  const total = JSON.stringify(e.toJSON()).length;
  assert.ok(total < 8000, 'embed raisonnable');
});
