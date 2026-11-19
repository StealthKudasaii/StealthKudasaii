import { Router, type Response } from 'express';
import { childLogger } from '../../core/logger';
import { completeLink } from '../../modules/rewards/verify';
import { finishAuthorization, oauthConfigured, startAuthorization } from '../../modules/rewards/roblox';

const log = childLogger('roblox-oauth');

function result(res: Response, ok: boolean, title: string, message: string, status = ok ? 200 : 400) {
  res.status(status).render('roblox-result', { title, message, ok });
}

/** Pages publiques de la liaison Roblox (le joueur arrive ici depuis le bouton de /rewards). */
export function robloxRouter(): Router {
  const r = Router();

  r.get('/roblox/link', (req, res) => {
    if (!oauthConfigured()) return result(res, false, 'Liaison indisponible', 'La connexion Roblox n’est pas encore activée par le staff.', 503);
    const url = startAuthorization(String(req.query.t ?? ''));
    if (!url) return result(res, false, 'Lien expiré', 'Ce lien a expiré ou a déjà servi. Retourne sur Discord et refais /rewards pour obtenir un nouveau lien.');
    res.redirect(url);
  });

  r.get('/roblox/callback', async (req, res) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    if (error) return result(res, false, 'Connexion annulée', 'Tu as annulé la connexion Roblox. Tu peux recommencer depuis /rewards sur Discord.');
    if (!code || !state) return result(res, false, 'Lien invalide', 'Paramètres manquants. Recommence depuis /rewards sur Discord.');
    try {
      const { discordId, profile } = await finishAuthorization(state, code);
      const err = await completeLink(discordId, profile, 'connexion Roblox');
      if (err) return result(res, false, 'Liaison impossible', err, 409);
      return result(res, true, 'Compte relié !', `Ton compte Roblox ${profile.username} est relié à ton compte Discord. Tu peux fermer cette page et retourner sur Discord.`);
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'Liaison Roblox échouée');
      return result(res, false, 'Liaison impossible', (e as Error).message);
    }
  });
  return r;
}
