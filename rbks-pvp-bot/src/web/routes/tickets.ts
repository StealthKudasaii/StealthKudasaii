import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { getSetting, setSetting } from '../../core/settings';
import { reasons, tickets } from '../../modules/tickets/tickets.repo';
import { closeTicket, publishTicketPanel, transcriptDir } from '../../modules/tickets/tickets.service';
import { audit } from '../../modules/audit/audit';
import { requireFeature } from '../middleware';
import { action, field, FormError, page } from '../helpers';

export function ticketsRouter(): Router {
  const r = Router();
  r.use('/tickets', requireFeature('tickets.handle'));

  r.get('/tickets', (req, res) => {
    const status = ['open', 'claimed', 'closed'].includes(String(req.query.status)) ? String(req.query.status) : undefined;
    const p = page(req);
    const { rows, total } = tickets.list({ status, limit: p.limit, offset: p.offset });
    res.render('tickets', {
      title: 'Tickets',
      rows,
      total,
      p,
      status,
      reasons: reasons.list(),
      settings: {
        closeMode: getSetting('tickets.closeMode'),
        maxOpen: getSetting('tickets.maxOpenPerUser'),
        cooldown: getSetting('tickets.cooldownSeconds'),
        panelTitle: getSetting('tickets.panelTitle'),
        panelDescription: getSetting('tickets.panelDescription'),
        welcome: getSetting('tickets.welcomeMessage'),
        dmTranscript: getSetting('tickets.dmTranscript'),
      },
    });
  });

  r.get('/tickets/:id', (req, res) => {
    const t = tickets.get(Number(req.params.id));
    if (!t) return res.status(404).render('error', { title: 'Introuvable', message: 'Ticket introuvable.', code: 404 });
    res.render('ticket', { title: `Ticket n°${t.id}`, t, notes: tickets.notes(t.id) });
  });

  // Transcript : servi en lecture seule, sans script (CSP sandbox).
  r.get('/tickets/:id/transcript', (req, res) => {
    const t = tickets.get(Number(req.params.id));
    if (!t?.transcript_file || !/^ticket-\d+\.html$/.test(t.transcript_file)) return res.status(404).render('error', { title: 'Introuvable', message: 'Aucun transcript.', code: 404 });
    const file = path.join(transcriptDir(), t.transcript_file);
    if (!fs.existsSync(file)) return res.status(404).render('error', { title: 'Introuvable', message: 'Fichier de transcript manquant.', code: 404 });
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src https: data:; style-src 'unsafe-inline'");
    res.type('html').send(fs.readFileSync(file, 'utf8'));
  });

  r.post('/tickets/:id/close', (req, res) =>
    action(req, res, `/tickets/${req.params.id}`, async () => {
      const err = await closeTicket(Number(req.params.id), req.member!.id, field.optStr(req.body, 'reason', 500));
      if (err) throw new FormError(err);
      return 'Ticket fermé, transcript enregistré.';
    }),
  );

  r.post('/tickets/:id/note', (req, res) =>
    action(req, res, `/tickets/${req.params.id}`, () => {
      const t = tickets.get(Number(req.params.id));
      if (!t) throw new FormError('Ticket introuvable.');
      const content = field.str(req.body, 'content', 1500);
      if (!content) throw new FormError('La note est vide.');
      tickets.addNote(t.id, req.member!.id, content);
      return 'Note interne ajoutée.';
    }),
  );

  // ───────────── Configuration (tickets.manage) ─────────────
  r.post('/tickets/settings', requireFeature('tickets.manage'), (req, res) =>
    action(req, res, '/tickets', async () => {
      setSetting('tickets.closeMode', field.oneOf(req.body, 'closeMode', ['delete', 'archive'] as const));
      setSetting('tickets.maxOpenPerUser', field.int(req.body, 'maxOpen', 1, 10) ?? 1);
      setSetting('tickets.cooldownSeconds', field.int(req.body, 'cooldown', 0, 86400) ?? 120);
      setSetting('tickets.panelTitle', field.str(req.body, 'panelTitle', 200) || 'Support');
      setSetting('tickets.panelDescription', field.str(req.body, 'panelDescription', 3000));
      setSetting('tickets.welcomeMessage', field.str(req.body, 'welcome', 1500));
      setSetting('tickets.dmTranscript', field.bool(req.body, 'dmTranscript'));
      await audit({ type: 'tickets', action: 'settings', actorId: req.member!.id, message: 'Configuration des tickets modifiée.' });
      return 'Configuration enregistrée.';
    }),
  );

  r.post('/tickets/panel', requireFeature('tickets.manage'), (req, res) =>
    action(req, res, '/tickets', async () => {
      const loc = await publishTicketPanel();
      return `Panneau publié/mis à jour (salon ${loc.channelId}).`;
    }),
  );

  r.post('/tickets/reasons', requireFeature('tickets.manage'), (req, res) =>
    action(req, res, '/tickets', () => {
      const label = field.str(req.body, 'label', 100);
      if (!label) throw new FormError('Le libellé est obligatoire.');
      if (reasons.list().length >= 25) throw new FormError('25 motifs maximum (limite Discord).');
      reasons.create({ label, emoji: field.optStr(req.body, 'emoji', 10), description: field.optStr(req.body, 'description', 100) });
      return 'Motif ajouté. Republie le panneau pour l’afficher.';
    }),
  );

  r.post('/tickets/reasons/:id', requireFeature('tickets.manage'), (req, res) =>
    action(req, res, '/tickets', () => {
      const id = Number(req.params.id);
      if (!reasons.get(id)) throw new FormError('Motif introuvable.');
      if (field.bool(req.body, 'delete')) {
        reasons.remove(id);
        return 'Motif supprimé.';
      }
      const label = field.str(req.body, 'label', 100);
      if (!label) throw new FormError('Le libellé est obligatoire.');
      reasons.update(id, { label, emoji: field.optStr(req.body, 'emoji', 10), description: field.optStr(req.body, 'description', 100), position: field.int(req.body, 'position', 0, 999) ?? 0, enabled: field.bool(req.body, 'enabled') });
      return 'Motif mis à jour.';
    }),
  );
  return r;
}
