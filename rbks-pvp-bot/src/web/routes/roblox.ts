import { Router, type Response } from 'express';
import { tryGetGuild } from '../../bot/client';
import { brandEmbed } from '../../bot/ui/embeds';
import { childLogger } from '../../core/logger';
import { audit } from '../../modules/audit/audit';
import { links } from '../../modules/rewards/rewards.repo';
import { evaluate, syncUser } from '../../modules/rewards/rewards.service';
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
      const owner = links.byRoblox(profile.id);
      if (owner && owner.discord_id !== discordId) {
        return result(res, false, 'Compte déjà relié', `Le compte Roblox ${profile.username} est déjà relié à un autre compte Discord. Si c’est une erreur, ouvre un ticket.`, 409);
      }
      const current = links.get(discordId);
      if (current && current.roblox_id !== profile.id) {
        return result(res, false, 'Un compte est déjà relié', `Ton Discord est déjà relié au compte Roblox ${current.roblox_username}. Pour en changer, demande au staff (ouvre un ticket).`, 409);
      }
      links.save(discordId, profile);
      await audit({ type: 'community', action: 'roblox_link', actorId: discordId, message: `🔗 <@${discordId}> a relié son compte Roblox **${profile.username}** (${profile.id}).` });
      await evaluate(discordId).catch(() => undefined);
      void syncUser(discordId);
      const member = await tryGetGuild()?.members.fetch(discordId).catch(() => null);
      await member?.send({ embeds: [brandEmbed({ title: '🔗 Compte Roblox relié', description: `Ton compte Discord est maintenant relié à **${profile.username}**. Tes récompenses débloquées arriveront en jeu automatiquement. Suis tes défis avec \`/rewards\`.` })] }).catch(() => undefined);
      return result(res, true, 'Compte relié !', `Ton compte Roblox ${profile.username} est relié à ton compte Discord. Tu peux fermer cette page et retourner sur Discord.`);
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'Liaison Roblox échouée');
      return result(res, false, 'Liaison impossible', (e as Error).message);
    }
  });
  return r;
}
