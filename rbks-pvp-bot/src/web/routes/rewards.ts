import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { env } from '../../config/env';
import { challenges, isMetric, links, METRICS, unlocks, type ChallengeInput } from '../../modules/rewards/rewards.repo';
import { syncPending, syncUser } from '../../modules/rewards/rewards.service';
import { oauthConfigured, openCloudConfigured, openCloudError, robloxRedirectUri, writeRewardsEntry } from '../../modules/rewards/roblox';
import { audit } from '../../modules/audit/audit';
import { requireFeature } from '../middleware';
import { action, field, FormError } from '../helpers';

const LUA_FILE = path.resolve(__dirname, '..', '..', '..', 'deploy', 'roblox', 'RBKSRewards.server.lua');
const lua = () => (fs.existsSync(LUA_FILE) ? fs.readFileSync(LUA_FILE, 'utf8') : '-- Fichier deploy/roblox/RBKSRewards.server.lua introuvable');

function readChallenge(body: Record<string, unknown>): ChallengeInput {
  const metric = field.str(body, 'metric', 40);
  if (!isMetric(metric)) throw new FormError('Type de défi inconnu.');
  const title = field.str(body, 'title', 100);
  const rewardId = field.str(body, 'reward_id', 50);
  const rewardLabel = field.str(body, 'reward_label', 100);
  if (!title || !rewardLabel) throw new FormError('Titre et récompense obligatoires.');
  if (!/^[A-Za-z0-9_.-]{1,50}$/.test(rewardId)) throw new FormError('Identifiant de récompense invalide : lettres, chiffres, « _ », « - » ou « . » (c’est la clé utilisée dans le script Roblox).');
  return {
    title,
    description: field.str(body, 'description', 200),
    metric,
    threshold: field.int(body, 'threshold', 1, 1_000_000) ?? 1,
    reward_id: rewardId,
    reward_label: rewardLabel,
    emoji: field.optStr(body, 'emoji', 10),
    position: field.int(body, 'position', 0, 999) ?? 0,
    enabled: field.bool(body, 'enabled'),
  };
}

export function rewardsRouter(): Router {
  const r = Router();
  r.use('/rewards', requireFeature('rewards.manage'));

  r.get('/rewards', (_req, res) => {
    res.render('rewards', {
      title: 'Récompenses /rewards',
      list: challenges.list(),
      metrics: METRICS,
      links: links.list().map((l) => ({ ...l, unlocked: unlocks.count(l.discord_id) })),
      cfg: {
        oauth: oauthConfigured(),
        openCloud: openCloudConfigured(),
        redirectUri: robloxRedirectUri(),
        https: env().PUBLIC_URL.startsWith('https://'),
        datastore: env().ROBLOX_DATASTORE,
        topic: env().ROBLOX_MESSAGING_TOPIC,
        universe: env().ROBLOX_UNIVERSE_ID ?? null,
      },
      lua: lua(),
    });
  });

  r.get('/rewards/RBKSRewards.server.lua', (_req, res) => {
    res.attachment('RBKSRewards.server.lua').type('text/plain; charset=utf-8').send(lua());
  });

  r.post('/rewards/challenges', (req, res) =>
    action(req, res, '/rewards#defis', async () => {
      const id = field.int(req.body, 'id', 1, 1e9);
      if (id && field.bool(req.body, 'delete')) {
        challenges.remove(id);
        links.markDirty();
        return 'Défi supprimé (la récompense ne sera plus livrée aux nouveaux joueurs ; celles déjà données en jeu restent).';
      }
      const data = readChallenge(req.body);
      if (id) {
        const before = challenges.get(id);
        if (!before) throw new FormError('Défi introuvable.');
        challenges.update(id, data);
        if (before.reward_id !== data.reward_id || before.enabled !== (data.enabled ? 1 : 0)) links.markDirty();
      } else challenges.create(data);
      await audit({ type: 'admin', action: 'reward_challenge', actorId: req.member!.id, message: `Défi /rewards « ${data.title} » ${id ? 'modifié' : 'créé'}.` });
      return 'Défi enregistré. Les membres qui l’ont déjà atteint le débloqueront à leur prochaine activité ou en ouvrant /rewards.';
    }),
  );

  r.post('/rewards/test', (req, res) =>
    action(req, res, '/rewards', async () => {
      if (!openCloudConfigured()) throw new FormError('Renseigne ROBLOX_OPEN_CLOUD_API_KEY et ROBLOX_UNIVERSE_ID dans .env, puis redémarre le bot.');
      try {
        await writeRewardsEntry({ discordId: 'test', robloxId: '1', rewards: [], updatedAt: new Date().toISOString() });
      } catch (e) {
        throw new FormError((e as Error).message || openCloudError(0, ''));
      }
      return `Connexion Open Cloud OK : écriture réussie dans le DataStore « ${env().ROBLOX_DATASTORE} ».`;
    }),
  );

  r.post('/rewards/sync', (req, res) =>
    action(req, res, '/rewards#comptes', async () => {
      const id = field.id(req.body, 'discord_id');
      if (id) {
        const out = await syncUser(id);
        if (!out.ok) throw new FormError(out.error ?? 'Échec.');
        return 'Récompenses renvoyées au jeu.';
      }
      links.markDirty();
      await syncPending();
      return 'Synchronisation lancée pour tous les comptes reliés.';
    }),
  );
  return r;
}
