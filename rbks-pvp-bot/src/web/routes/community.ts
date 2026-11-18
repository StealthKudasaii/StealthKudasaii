import { Router } from 'express';
import { BUG_STATUS, SUGGESTION_STATUS, type BugStatus, type SuggestionStatus } from '../../config/constants';
import { suggestions, setSuggestionStatus } from '../../modules/community/suggestions';
import { addBugNote, attachmentsOf, bugs, setBugStatus, refreshBug } from '../../modules/community/bugs';
import { cancelSession, createSession, sessions } from '../../modules/community/testsessions';
import { createPoll, endPoll, optionsOf, parsePollOptions, polls } from '../../modules/community/polls';
import { channelId } from '../../core/resources';
import { parseDuration } from '../../core/time';
import { sanitizeMentions } from '../../core/text';
import { requireFeature } from '../middleware';
import { action, field, FormError, guildRoles, guildTextChannels, page } from '../helpers';

const keys = <T extends object>(o: T) => Object.keys(o) as (keyof T & string)[];

export function communityRouter(): Router {
  const r = Router();

  // ───────────── Suggestions ─────────────
  r.get('/suggestions', requireFeature('suggestions.manage'), (req, res) => {
    const status = Object.prototype.hasOwnProperty.call(SUGGESTION_STATUS, String(req.query.status)) ? String(req.query.status) : undefined;
    const p = page(req);
    const { rows, total } = suggestions.list(status, p.limit, p.offset);
    res.render('suggestions', { title: 'Suggestions', rows, total, p, status });
  });

  r.post('/suggestions/:id', requireFeature('suggestions.manage'), (req, res) =>
    action(req, res, req.get('referer')?.includes('/suggestions') ? req.get('referer')! : '/suggestions', async () => {
      const id = Number(req.params.id);
      if (!suggestions.get(id)) throw new FormError('Suggestion introuvable.');
      await setSuggestionStatus(id, field.oneOf(req.body, 'status', keys(SUGGESTION_STATUS)) as SuggestionStatus, field.optStr(req.body, 'response', 900), req.member!.id);
      return 'Suggestion mise à jour sur Discord.';
    }),
  );

  // ───────────── Bugs ─────────────
  r.get('/bugs', requireFeature('bugs.manage'), (req, res) => {
    const status = req.query.status === 'all' ? undefined : Object.prototype.hasOwnProperty.call(BUG_STATUS, String(req.query.status)) ? String(req.query.status) : 'open';
    const p = page(req);
    const { rows, total } = bugs.list(status, p.limit, p.offset);
    res.render('bugs', { title: 'Bugs', rows, total, p, status: req.query.status === 'all' ? 'all' : status });
  });

  r.get('/bugs/:id', requireFeature('bugs.manage'), (req, res) => {
    const b = bugs.get(Number(req.params.id));
    if (!b) return res.status(404).render('error', { title: 'Introuvable', message: 'Bug introuvable.', code: 404 });
    res.render('bug', { title: `Bug n°${b.id}`, b, events: bugs.events(b.id), files: attachmentsOf(b) });
  });

  r.post('/bugs/:id', requireFeature('bugs.manage'), (req, res) => {
    const id = Number(req.params.id);
    return action(req, res, `/bugs/${id}`, async () => {
      const b = bugs.get(id);
      if (!b) throw new FormError('Bug introuvable.');
      const op = field.oneOf(req.body, 'op', ['status', 'note', 'assign'] as const);
      if (op === 'status') {
        await setBugStatus(id, field.oneOf(req.body, 'status', keys(BUG_STATUS)) as BugStatus, req.member!.id, field.optStr(req.body, 'comment', 500));
        return 'Statut mis à jour.';
      }
      if (op === 'assign') {
        bugs.assign(id, req.member!.id);
        await refreshBug(id);
        return 'Tu as pris ce bug en charge.';
      }
      const content = field.str(req.body, 'content', 1500);
      if (!content) throw new FormError('La note est vide.');
      await addBugNote(id, req.member!.id, content);
      return 'Note interne ajoutée.';
    });
  });

  // ───────────── Sessions de test ─────────────
  r.get('/sessions', requireFeature('testsessions.manage'), (_req, res) => {
    res.render('sessions', {
      title: 'Sessions de test',
      list: sessions.list().map((s) => ({ ...s, participants: sessions.participants(s.id) })),
      channels: guildTextChannels(),
      roles: guildRoles(),
      defaultChannel: channelId('testers'),
    });
  });

  r.post('/sessions', requireFeature('testsessions.manage'), (req, res) =>
    action(req, res, '/sessions', async () => {
      const cancel = field.int(req.body, 'cancel', 1, 1e9);
      if (cancel) {
        await cancelSession(cancel, req.member!.id);
        return 'Session annulée, participants prévenus.';
      }
      const name = field.str(req.body, 'name', 100);
      const startsAt = field.date(req.body, 'starts_at');
      const slots = field.int(req.body, 'slots', 1, 500);
      const channel = field.id(req.body, 'channel');
      if (!name || !startsAt || !slots || !channel) throw new FormError('Nom, date, nombre de places et salon obligatoires.');
      if (startsAt < Date.now()) throw new FormError('La date est déjà passée.');
      const s = await createSession({
        name,
        description: field.str(req.body, 'description', 1500),
        starts_at: startsAt,
        duration_minutes: field.int(req.body, 'duration', 5, 1440),
        slots,
        role_id: field.id(req.body, 'role'),
        channel_id: channel,
        created_by: req.member!.id,
        ping: field.bool(req.body, 'ping'),
      });
      return `Session n°${s.id} publiée sur Discord.`;
    }),
  );

  // ───────────── Sondages ─────────────
  r.get('/polls', requireFeature('polls.manage'), (_req, res) => {
    res.render('polls', {
      title: 'Sondages',
      list: polls.list().map((p) => ({ ...p, opts: optionsOf(p), results: polls.results(p.id) })),
      channels: guildTextChannels(),
    });
  });

  r.post('/polls', requireFeature('polls.manage'), (req, res) =>
    action(req, res, '/polls', async () => {
      const end = field.int(req.body, 'end', 1, 1e9);
      if (end) {
        if (!(await endPoll(end, req.member!.id))) throw new FormError('Sondage introuvable ou déjà terminé.');
        return 'Sondage terminé.';
      }
      const question = field.str(req.body, 'question', 200);
      const channel = field.id(req.body, 'channel');
      if (!question || !channel) throw new FormError('Question et salon obligatoires.');
      const parsed = parsePollOptions(field.str(req.body, 'options', 3000));
      if (!parsed.ok) throw new FormError(parsed.error);
      const durRaw = field.str(req.body, 'duration', 10);
      const duration = durRaw ? parseDuration(durRaw) : null;
      if (durRaw && !duration) throw new FormError('Durée invalide (ex. 30m, 2h, 3j).');
      const p = await createPoll({
        question: sanitizeMentions(question),
        options: parsed.options,
        multi: field.bool(req.body, 'multi'),
        anonymous: field.bool(req.body, 'anonymous'),
        live: field.bool(req.body, 'live'),
        durationMs: duration,
        channelId: channel,
        createdBy: req.member!.id,
      });
      return `Sondage n°${p.id} publié.`;
    }),
  );
  return r;
}
