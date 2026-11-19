import { Router } from 'express';
import { campaigns } from '../../modules/massdm/massdm.repo';
import { exportCsv, exportJson, exportLua, isRunning } from '../../modules/massdm/massdm.service';
import { audit } from '../../modules/audit/audit';
import { requireFeature } from '../middleware';
import { guildRoles } from '../helpers';

export function massdmRouter(): Router {
  const r = Router();
  r.use('/massdm', requireFeature('massdm.manage'));

  r.get('/massdm', (_req, res) => {
    res.render('massdm', {
      title: 'Envois groupés et clés',
      roles: guildRoles(),
      list: campaigns.list().map((c) => ({ ...c, counts: campaigns.counts(c.id), running: isRunning(c.id) })),
    });
  });

  // Téléchargement des clés (réservé aux personnes autorisées, jamais mis en cache).
  r.get('/massdm/:id/export.:format', async (req, res) => {
    const c = campaigns.get(Number(req.params.id));
    const format = req.params.format;
    if (!c || !c.with_keys || !['lua', 'csv', 'json'].includes(format)) {
      return res.status(404).render('error', { title: 'Introuvable', message: 'Export introuvable.', code: 404 });
    }
    const base = c.name.replace(/[^\w-]+/g, '_');
    const body = format === 'lua' ? exportLua(c.id) : format === 'csv' ? exportCsv(c.id) : exportJson(c.id);
    const name = format === 'lua' ? `RBKSAccessKeys-${base}.lua` : `cles-${base}.${format}`;
    await audit({ type: 'admin', action: 'massdm_export', actorId: req.member!.id, target: c.name, message: `Export ${format.toUpperCase()} des clés du lot « ${c.name} » depuis le panel.` });
    res.setHeader('Cache-Control', 'no-store');
    res.attachment(name).type(format === 'json' ? 'application/json' : 'text/plain; charset=utf-8').send(body);
  });
  return r;
}
