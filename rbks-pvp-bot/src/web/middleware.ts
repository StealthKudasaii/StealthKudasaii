import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { GuildMember } from 'discord.js';
import { can, type Feature } from '../core/permissions';
import { tryGetGuild } from '../bot/client';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      member?: GuildMember;
    }
  }
}

export function flash(req: Request, type: 'success' | 'error' | 'info', message: string): void {
  req.session.flash = [...(req.session.flash ?? []), { type, message }];
}

export function csrfToken(req: Request): string {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex');
  return req.session.csrf;
}

/** Protection CSRF : jeton de session obligatoire sur toutes les requêtes qui modifient des données. */
export function verifyCsrf(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = (req.body?._csrf as string | undefined) ?? req.get('x-csrf-token');
  const expected = req.session.csrf;
  if (!sent || !expected || sent.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected))) {
    res.status(403).render('error', { title: 'Requête refusée', message: 'Jeton de sécurité invalide ou expiré. Recharge la page et réessaie.', code: 403 });
    return;
  }
  next();
}

/**
 * Authentification + autorisation : la session ne suffit pas, l'accès est revérifié à chaque requête
 * à partir des rôles actuels du membre sur le serveur (retirer un rôle coupe l'accès immédiatement).
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = req.session.user;
  if (!user) {
    if (req.method === 'GET') req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  const guild = tryGetGuild();
  if (!guild) {
    res.status(503).render('error', { title: 'Bot hors ligne', message: 'Le bot n’est pas connecté à Discord pour le moment. Réessaie dans un instant.', code: 503 });
    return;
  }
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member || !can(member, 'panel.access')) {
    req.session.destroy(() => undefined);
    res.status(403).render('error', { title: 'Accès refusé', message: 'Ton compte n’a pas (ou plus) accès au panel. Demande au Fondateur de t’ajouter un rôle autorisé.', code: 403 });
    return;
  }
  req.member = member;
  next();
}

export function requireFeature(feature: Feature) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (can(req.member, feature)) return next();
    res.status(403).render('error', { title: 'Accès refusé', message: 'Ton rôle ne permet pas d’accéder à cette section.', code: 403 });
  };
}

/** Variables communes aux vues. */
export function locals(req: Request, res: Response, next: NextFunction): void {
  res.locals.user = req.session.user ?? null;
  res.locals.csrf = csrfToken(req);
  res.locals.flash = req.session.flash ?? [];
  req.session.flash = [];
  res.locals.path = req.path;
  res.locals.can = (f: Feature) => (req.member ? can(req.member, f) : false);
  next();
}
