import { Router } from 'express';
import { serverStats } from '../../modules/stats/stats.service';
import { listLogs } from '../../modules/logs/audit';
import { isBotReady, tryGetGuild, getClient } from '../../bot/client';
import { can } from '../../core/permissions';
import { listResources } from '../../core/resources';

const startedAt = Date.now();

export function dashboardRouter(): Router {
  const r = Router();
  r.get('/', (req, res) => {
    const ready = isBotReady();
    const guild = tryGetGuild();
    const client = ready ? getClient() : null;
    res.render('dashboard', {
      title: 'Tableau de bord',
      stats: serverStats(),
      bot: {
        ready,
        tag: client?.user?.tag ?? null,
        avatar: client?.user?.displayAvatarURL({ size: 128 }) ?? null,
        ping: client ? Math.round(client.ws.ping) : null,
        uptime: Date.now() - startedAt,
        guildName: guild?.name ?? null,
        guildIcon: guild?.iconURL({ size: 128 }) ?? null,
      },
      setupDone: listResources().length > 0,
      logs: can(req.member, 'logs.view') ? listLogs({ limit: 12 }).rows : [],
    });
  });
  return r;
}
