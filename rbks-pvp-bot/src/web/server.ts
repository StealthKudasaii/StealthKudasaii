import path from 'node:path';
import type { Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { childLogger } from '../core/logger';
import * as constants from '../config/constants';
import { formatDate, toInputValue, toFrInput } from '../core/time';
import { escapeHtml, progressBar, truncate } from '../core/text';
import { SqliteSessionStore } from './sessionStore';
import { authRouter } from './auth';
import { locals, requireAuth, verifyCsrf } from './middleware';
import { memberName } from './helpers';
import { dashboardRouter } from './routes/dashboard';
import { botRouter } from './routes/bot';
import { settingsRouter } from './routes/settings';
import { ticketsRouter } from './routes/tickets';
import { formsRouter } from './routes/forms';
import { devRouter } from './routes/dev';
import { communityRouter } from './routes/community';
import { publicationsRouter } from './routes/publications';
import { logsRouter } from './routes/logs';

const log = childLogger('web');
const ROOT = path.resolve(__dirname, '..', '..');

/** Badge HTML pour un statut (libellés issus des constantes, donc sûrs). */
function badge(map: Record<string, { label: string; emoji: string; color: number }>, key: string): string {
  const m = map[key];
  if (!m) return `<span class="badge">${escapeHtml(String(key))}</span>`;
  const C = constants.COLORS;
  const cls = m.color === C.success ? 'ok' : m.color === C.danger ? 'danger' : m.color === C.warning ? 'warn' : m.color === C.info ? 'info' : '';
  return `<span class="badge ${cls}">${m.emoji} ${escapeHtml(m.label)}</span>`;
}

export function createApp() {
  const e = env();
  const app = express();
  if (e.TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'web', 'views'));

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", 'https://fonts.googleapis.com'],
          // Attributs style="" (largeurs des barres de progression) : sans risque d'exécution de script.
          styleSrcAttr: ["'unsafe-inline'"],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com', 'https://media.discordapp.net', 'https:'],
          formAction: ["'self'", 'https://discord.com'],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: e.PUBLIC_URL.startsWith('https') ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use('/public', express.static(path.join(ROOT, 'web', 'public'), { maxAge: '1d' }));
  app.use(express.urlencoded({ extended: true, limit: '300kb' }));
  app.use(
    session({
      name: 'rbks.sid',
      secret: e.SESSION_SECRET,
      store: new SqliteSessionStore(),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { httpOnly: true, sameSite: 'lax', secure: e.PUBLIC_URL.startsWith('https'), maxAge: 7 * 864e5 },
    }),
  );
  app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.use(['/auth', '/login'], rateLimit({ windowMs: 15 * 60_000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false }));

  // Helpers disponibles dans toutes les vues.
  Object.assign(app.locals, { C: constants, fmt: formatDate, toInputValue, toFrInput, progressBar, truncate, memberName, badge, brandUrl: e.PUBLIC_URL });
  app.use(locals);

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(authRouter());

  // Tout ce qui suit exige une session valide ET un rôle autorisé (revérifié à chaque requête).
  app.use(requireAuth);
  // Les envois de fichiers (multipart) vérifient le jeton CSRF après lecture du formulaire, dans leur route.
  app.use((req, res, next) => (req.is('multipart/form-data') ? next() : verifyCsrf(req, res, next)));
  app.use(dashboardRouter());
  app.use(botRouter());
  app.use(settingsRouter());
  app.use(ticketsRouter());
  app.use(formsRouter());
  app.use(devRouter());
  app.use(communityRouter());
  app.use(publicationsRouter());
  app.use(logsRouter());

  app.use((_req, res) => res.status(404).render('error', { title: 'Introuvable', message: 'Cette page n’existe pas.', code: 404 }));
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error({ err }, 'Erreur du panel');
    if (res.headersSent) return;
    res.status(500).render('error', { title: 'Erreur', message: 'Une erreur interne est survenue. Elle a été enregistrée dans les logs techniques.', code: 500 });
  });
  return app;
}

export function startWeb(): Promise<Server> {
  const e = env();
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(e.WEB_PORT, e.WEB_HOST, () => {
      log.info({ url: e.PUBLIC_URL, port: e.WEB_PORT }, 'Panel web démarré');
      resolve(server);
    });
  });
}
