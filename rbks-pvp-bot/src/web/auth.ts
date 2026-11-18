import crypto from 'node:crypto';
import { Router } from 'express';
import { env } from '../config/env';
import { can } from '../core/permissions';
import { tryGetGuild } from '../bot/client';
import { childLogger } from '../core/logger';
import { audit } from '../modules/logs/audit';
import { verifyCsrf } from './middleware';

const log = childLogger('web-auth');
const DISCORD_API = 'https://discord.com/api/v10';

export const redirectUri = () => `${env().PUBLIC_URL}/auth/callback`;

/** Connexion via Discord OAuth2 (scope « identify » uniquement : aucune donnée inutile n'est demandée). */
export function authRouter(): Router {
  const r = Router();

  r.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('login', { title: 'Connexion' });
  });

  r.get('/auth/discord', (req, res) => {
    const state = crypto.randomBytes(24).toString('hex');
    req.session.oauthState = state;
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', env().DISCORD_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'none');
    req.session.save(() => res.redirect(url.toString()));
  });

  r.get('/auth/callback', async (req, res) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    const expected = req.session.oauthState;
    delete req.session.oauthState;
    if (error) return res.status(400).render('error', { title: 'Connexion annulée', message: 'La connexion Discord a été annulée.', code: 400 });
    if (!code || !state || !expected || state.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
      return res.status(400).render('error', { title: 'Connexion refusée', message: 'Paramètre de sécurité invalide. Relance la connexion.', code: 400 });
    }
    try {
      const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env().DISCORD_CLIENT_ID,
          client_secret: env().DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri(),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!tokenRes.ok) {
        log.warn({ status: tokenRes.status }, 'Échange du code OAuth2 refusé (redirect URI ou client secret ?)');
        return res.status(400).render('error', { title: 'Connexion refusée', message: 'Discord a refusé la connexion. Vérifie la configuration OAuth2 (URL de redirection et Client Secret).', code: 400 });
      }
      const token = (await tokenRes.json()) as { access_token: string; token_type: string };
      const userRes = await fetch(`${DISCORD_API}/users/@me`, { headers: { authorization: `${token.token_type} ${token.access_token}` }, signal: AbortSignal.timeout(10_000) });
      if (!userRes.ok) throw new Error(`users/@me ${userRes.status}`);
      const u = (await userRes.json()) as { id: string; username: string; global_name: string | null; avatar: string | null };
      // Le jeton Discord n'est pas conservé : il ne sert qu'à identifier la personne.
      const guild = tryGetGuild();
      const member = guild ? await guild.members.fetch(u.id).catch(() => null) : null;
      if (!member || !can(member, 'panel.access')) {
        await audit({ type: 'admin', action: 'panel_denied', actorId: u.id, message: `Connexion au panel refusée pour ${u.username} (accès non autorisé).` });
        return res.status(403).render('error', { title: 'Accès refusé', message: 'Ton compte Discord n’a pas accès au panel RBKS PVP.', code: 403 });
      }
      const returnTo = req.session.returnTo;
      req.session.regenerate((err) => {
        if (err) return res.status(500).render('error', { title: 'Erreur', message: 'Session impossible.', code: 500 });
        req.session.user = { id: u.id, username: u.username, globalName: u.global_name, avatar: u.avatar };
        req.session.save(() => res.redirect(returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/'));
      });
      await audit({ type: 'admin', action: 'panel_login', actorId: u.id, message: `Connexion au panel : ${u.username}.` });
    } catch (e) {
      log.error({ err: e }, 'Erreur OAuth2');
      res.status(500).render('error', { title: 'Erreur', message: 'Impossible de contacter Discord. Réessaie.', code: 500 });
    }
  });

  r.post('/logout', verifyCsrf, (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('rbks.sid');
      res.redirect('/login');
    });
  });

  return r;
}
