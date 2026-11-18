import { Router } from 'express';
import { applications, answersOf, choicesOf, forms, questions, reviewerRoles } from '../../modules/whitelist/forms.repo';
import { BETA_TEMPLATE, FORM_STATE_LABEL, MAX_QUESTIONS, answerText, formState, pages, parseQuestionInput } from '../../modules/whitelist/forms.logic';
import { addApplicationNote, decide, publishForm, scheduleFormRefresh, statsSummary, unpublishForm } from '../../modules/whitelist/forms.service';
import { audit } from '../../modules/logs/audit';
import { can } from '../../core/permissions';
import { channelId, roleId } from '../../core/resources';
import { isHttpUrl } from '../../core/text';
import { getGuild } from '../../bot/client';
import { requireFeature } from '../middleware';
import { action, field, FormError, guildRoles, guildTextChannels, page } from '../helpers';
import type { Request } from 'express';

function canReview(req: Request, formId: number): boolean {
  const f = forms.get(formId);
  return can(req.member, 'whitelist.review', f ? reviewerRoles(f) : []);
}

export function formsRouter(): Router {
  const r = Router();

  r.get('/forms', (req, res) => {
    const list = forms.list().map((f) => {
      const s = applications.stats(f.id);
      return { ...f, stats: s, state: FORM_STATE_LABEL[formState(f, s.total)], questionCount: questions.count(f.id), canReview: canReview(req, f.id) };
    });
    if (!can(req.member, 'whitelist.manage') && !list.some((f) => f.canReview)) return res.status(403).render('error', { title: 'Accès refusé', message: 'Section réservée.', code: 403 });
    res.render('forms', { title: 'Formulaires de candidature', list, summary: statsSummary() });
  });

  r.post('/forms', requireFeature('whitelist.manage'), (req, res) => {
    let created: number | null = null;
    return action(req, res, () => (created ? `/forms/${created}` : '/forms'), () => {
      const name = field.str(req.body, 'name', 40);
      const title = field.str(req.body, 'title', 200);
      if (!name || !title) throw new FormError('Nom et titre obligatoires.');
      if (forms.byName(name)) throw new FormError('Ce nom est déjà utilisé.');
      const id = forms.create({
        name,
        title,
        description: field.str(req.body, 'description', 2000),
        button_label: field.str(req.body, 'button', 80) || 'Postuler',
        banner_url: null,
        review_channel_id: channelId('applications'),
        accepted_role_id: roleId('tester'),
        created_by: req.member!.id,
      });
      if (field.bool(req.body, 'template')) for (const q of BETA_TEMPLATE) questions.create(id, q);
      created = id;
      return 'Formulaire créé. Configure les salons puis publie-le.';
    });
  });

  r.get('/forms/:id', requireFeature('whitelist.manage'), (req, res) => {
    const f = forms.get(Number(req.params.id));
    if (!f) return res.status(404).render('error', { title: 'Introuvable', message: 'Formulaire introuvable.', code: 404 });
    const qs = questions.list(f.id).map((q) => ({ ...q, choicesText: choicesOf(q).join('\n') }));
    res.render('form', {
      title: f.title,
      f,
      qs,
      reviewers: reviewerRoles(f),
      state: FORM_STATE_LABEL[formState(f, applications.countForForm(f.id))],
      pageCount: pages(questions.list(f.id)).length,
      maxQuestions: MAX_QUESTIONS,
      channels: guildTextChannels(),
      roles: guildRoles(),
      summary: statsSummary(f.id),
    });
  });

  r.post('/forms/:id', requireFeature('whitelist.manage'), (req, res) => {
    const id = Number(req.params.id);
    return action(req, res, `/forms/${id}`, async () => {
      const f = forms.get(id);
      if (!f) throw new FormError('Formulaire introuvable.');
      const name = field.str(req.body, 'name', 40);
      const other = forms.byName(name);
      if (!name || (other && other.id !== id)) throw new FormError('Nom vide ou déjà utilisé.');
      const banner = field.optStr(req.body, 'banner', 500);
      if (banner && !isHttpUrl(banner)) throw new FormError('URL de bannière invalide.');
      const accepted = field.id(req.body, 'accepted');
      if (accepted) {
        const role = getGuild().roles.cache.get(accepted);
        if (!role || role.managed) throw new FormError('Rôle d’acceptation invalide.');
        if (role.id === roleId('founder')) throw new FormError('Le rôle Fondateur ne peut jamais être attribué automatiquement.');
        if (role.position >= getGuild().members.me!.roles.highest.position) throw new FormError(`Le rôle ${role.name} est au-dessus du bot : il ne pourra pas l’attribuer.`);
      }
      const opens = field.date(req.body, 'opens');
      const closes = field.date(req.body, 'closes');
      if (opens && closes && closes <= opens) throw new FormError('La clôture doit être après l’ouverture.');
      forms.update(id, {
        name,
        title: field.str(req.body, 'title', 200) || f.title,
        description: field.str(req.body, 'description', 2000),
        button_label: field.str(req.body, 'button', 80) || 'Postuler',
        banner_url: banner,
        publish_channel_id: field.id(req.body, 'publish'),
        review_channel_id: field.id(req.body, 'review'),
        reviewer_role_ids: field.ids(req.body, 'reviewers'),
        accepted_role_id: accepted,
        max_applications: field.int(req.body, 'max', 1, 100000),
        reapply_days: field.int(req.body, 'reapply', 0, 365) ?? 0,
        opens_at: opens,
        closes_at: closes,
        dm_on_decision: field.bool(req.body, 'dm') ? 1 : 0,
      });
      scheduleFormRefresh(id);
      await audit({ type: 'applications', action: 'form_edit', actorId: req.member!.id, target: name, message: `Formulaire « ${name} » modifié depuis le panel.` });
      return 'Formulaire enregistré. Le message publié est mis à jour automatiquement.';
    });
  });

  r.post('/forms/:id/status', requireFeature('whitelist.manage'), (req, res) => {
    const id = Number(req.params.id);
    let deleted = false;
    return action(req, res, () => (deleted ? '/forms' : `/forms/${id}`), async () => {
      const f = forms.get(id);
      if (!f) throw new FormError('Formulaire introuvable.');
      const op = field.oneOf(req.body, 'op', ['publish', 'open', 'close', 'unpublish', 'delete'] as const);
      if (op === 'publish') {
        await publishForm(id);
        await audit({ type: 'applications', action: 'form_publish', actorId: req.member!.id, target: f.name, message: `Formulaire « ${f.title} » publié depuis le panel.` });
        return 'Formulaire publié sur Discord.';
      }
      if (op === 'open' || op === 'close') {
        if (op === 'open' && !questions.count(id)) throw new FormError('Ajoute au moins une question.');
        forms.update(id, { status: op === 'open' ? 'open' : 'closed' });
        scheduleFormRefresh(id);
        await audit({ type: 'applications', action: `form_${op}`, actorId: req.member!.id, target: f.name, message: `Formulaire « ${f.title} » ${op === 'open' ? 'ouvert' : 'fermé'}.` });
        return op === 'open' ? 'Candidatures ouvertes.' : 'Candidatures fermées.';
      }
      if (op === 'unpublish') {
        await unpublishForm(f);
        return 'Message public retiré.';
      }
      if (field.str(req.body, 'confirm', 60) !== f.name) throw new FormError(`Pour supprimer, recopie exactement le nom du formulaire (« ${f.name} »).`);
      await unpublishForm(f).catch(() => undefined);
      forms.remove(id);
      await audit({ type: 'applications', action: 'form_delete', actorId: req.member!.id, target: f.name, message: `Formulaire « ${f.title} » supprimé depuis le panel.` });
      deleted = true;
      return 'Formulaire supprimé.';
    });
  });

  r.post('/forms/:id/questions', requireFeature('whitelist.manage'), (req, res) => {
    const id = Number(req.params.id);
    return action(req, res, `/forms/${id}#questions`, () => {
      if (!forms.get(id)) throw new FormError('Formulaire introuvable.');
      if (questions.count(id) >= MAX_QUESTIONS) throw new FormError(`${MAX_QUESTIONS} questions maximum.`);
      const parsed = parseQuestionInput({
        label: field.str(req.body, 'label', 100),
        description: field.str(req.body, 'description', 200),
        type: field.str(req.body, 'type', 20),
        required: field.bool(req.body, 'required'),
        choices: field.str(req.body, 'choices', 3000),
        placeholder: field.str(req.body, 'placeholder', 200),
        range: field.str(req.body, 'range', 40),
      });
      if (!parsed.ok) throw new FormError(parsed.error);
      questions.create(id, parsed.value);
      return 'Question ajoutée.';
    });
  });

  r.post('/forms/:id/template', requireFeature('whitelist.manage'), (req, res) => {
    const id = Number(req.params.id);
    return action(req, res, `/forms/${id}#questions`, () => {
      if (questions.count(id)) throw new FormError('Le modèle ne s’applique qu’à un formulaire vide.');
      for (const q of BETA_TEMPLATE) questions.create(id, q);
      return 'Modèle bêta ajouté.';
    });
  });

  r.post('/forms/:id/questions/:qid', requireFeature('whitelist.manage'), (req, res) => {
    const id = Number(req.params.id);
    return action(req, res, `/forms/${id}#questions`, () => {
      const q = questions.get(Number(req.params.qid));
      if (!q || q.form_id !== id) throw new FormError('Question introuvable.');
      const op = field.oneOf(req.body, 'op', ['save', 'up', 'down', 'delete'] as const, 'save');
      if (op === 'delete') {
        questions.remove(q.id);
        return 'Question supprimée.';
      }
      if (op === 'up' || op === 'down') {
        questions.move(q.id, op === 'up' ? -1 : 1);
        return;
      }
      const parsed = parseQuestionInput({
        label: field.str(req.body, 'label', 100),
        description: field.str(req.body, 'description', 200),
        type: field.str(req.body, 'type', 20),
        required: field.bool(req.body, 'required'),
        choices: field.str(req.body, 'choices', 3000),
        placeholder: field.str(req.body, 'placeholder', 200),
        range: field.str(req.body, 'range', 40),
      });
      if (!parsed.ok) throw new FormError(parsed.error);
      questions.update(q.id, parsed.value);
      return 'Question mise à jour.';
    });
  });

  // ───────────── Candidatures ─────────────
  r.get('/applications', (req, res) => {
    const formId = Number(req.query.form) || undefined;
    if (formId ? !canReview(req, formId) : !can(req.member, 'whitelist.review')) return res.status(403).render('error', { title: 'Accès refusé', message: 'Tu ne peux pas examiner ces candidatures.', code: 403 });
    const status = ['pending', 'on_hold', 'accepted', 'refused'].includes(String(req.query.status)) ? String(req.query.status) : undefined;
    const p = page(req);
    const { rows, total } = applications.list({ formId, status, limit: p.limit, offset: p.offset });
    res.render('applications', { title: 'Candidatures', rows, total, p, status, formId, forms: forms.list(), formTitle: (id: number) => forms.get(id)?.title ?? '—' });
  });

  r.get('/applications/:id', (req, res) => {
    const a = applications.get(Number(req.params.id));
    if (!a) return res.status(404).render('error', { title: 'Introuvable', message: 'Candidature introuvable.', code: 404 });
    if (!canReview(req, a.form_id)) return res.status(403).render('error', { title: 'Accès refusé', message: 'Tu ne peux pas examiner cette candidature.', code: 403 });
    const member = getGuild().members.cache.get(a.user_id);
    res.render('application', {
      title: `Candidature n°${a.id}`,
      a,
      f: forms.get(a.form_id),
      answers: answersOf(a).map((x) => ({ label: x.label, text: answerText(x) })),
      notes: applications.notes(a.id),
      events: applications.events(a.id),
      member: member ? { tag: member.user.tag, avatar: member.displayAvatarURL({ size: 128 }), joined: member.joinedTimestamp, created: member.user.createdTimestamp } : null,
      others: applications.list({ formId: a.form_id }).rows.filter((x) => x.user_id === a.user_id && x.id !== a.id),
    });
  });

  r.post('/applications/:id/decision', (req, res) => {
    const id = Number(req.params.id);
    return action(req, res, `/applications/${id}`, async () => {
      const a = applications.get(id);
      if (!a) throw new FormError('Candidature introuvable.');
      if (!canReview(req, a.form_id)) throw new FormError('Action non autorisée.');
      const decision = field.oneOf(req.body, 'decision', ['accepted', 'refused', 'on_hold'] as const);
      const res2 = await decide(id, req.member!.id, decision, field.optStr(req.body, 'reason', 800), field.bool(req.body, 'notify'));
      if (!res2.ok) throw new FormError(res2.error!.replace(/<@(\d+)>/g, 'un membre du staff'));
      return `Décision enregistrée.${res2.warnings.length ? ' ⚠️ ' + res2.warnings.join(' ') : ''}`;
    });
  });

  r.post('/applications/:id/note', (req, res) => {
    const id = Number(req.params.id);
    return action(req, res, `/applications/${id}`, async () => {
      const a = applications.get(id);
      if (!a || !canReview(req, a.form_id)) throw new FormError('Action non autorisée.');
      const content = field.str(req.body, 'content', 1500);
      if (!content) throw new FormError('La note est vide.');
      await addApplicationNote(id, req.member!.id, content);
      return 'Note ajoutée.';
    });
  });
  return r;
}
