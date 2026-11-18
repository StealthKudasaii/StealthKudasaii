import { Router } from 'express';
import { listLogs, logData, LOG_TYPES } from '../../modules/logs/audit';
import { requireFeature } from '../middleware';
import { page } from '../helpers';

export function logsRouter(): Router {
  const r = Router();
  r.get('/logs', requireFeature('logs.view'), (req, res) => {
    const type = Object.prototype.hasOwnProperty.call(LOG_TYPES, String(req.query.type)) ? String(req.query.type) : undefined;
    const p = page(req, 50);
    const { rows, total } = listLogs({ type, limit: p.limit, offset: p.offset });
    res.render('logs', { title: 'Logs', rows: rows.map((r) => ({ ...r, extra: logData(r) })), total, p, type, types: LOG_TYPES });
  });
  return r;
}
