import { Router } from 'express';
import { allChannelSpecs, NOTIFICATION_TYPES } from '../../config/layout';
import { getSetting, setSetting } from '../../core/settings';
import { channelId, getResource, roleId, setResource } from '../../core/resources';
import { FEATURES, featureRoleIds, isFeature, isFeatureCustomized, setFeatureRoles, type Feature } from '../../core/permissions';
import { LOG_TYPES } from '../../modules/logs/audit';
import { audit } from '../../modules/logs/audit';
import { listBackups, backupDatabase } from '../../core/backup';
import { publishAllPanels } from '../../modules/setup';
import { requireFeature } from '../middleware';
import { action, field, guildRoles, guildTextChannels, FormError } from '../helpers';

export function settingsRouter(): Router {
  const r = Router();

  r.get('/settings', requireFeature('settings.manage'), (_req, res) => {
    const specs = allChannelSpecs().filter((c) => c.type === 0);
    res.render('settings', {
      title: 'Réglages',
      channels: guildTextChannels(),
      roles: guildRoles(),
      channelRows: [
        ...specs.map((s) => ({ key: s.key, name: `#${s.name}`, current: channelId(s.key), managed: getResource(`channel:${s.key}`)?.discord_id ?? null })),
        { key: 'roadmap', name: 'Roadmap (par défaut #release)', current: getSetting('channels.overrides')['roadmap'] ?? null, managed: null },
      ],
      notif: NOTIFICATION_TYPES.map((n) => ({ ...n, roleId: roleId(n.role) })),
      memberRole: roleId('member'),
      logTypes: LOG_TYPES,
      logsEnabled: getSetting('logs.enabled'),
      s: {
        autorole: getSetting('members.autoroleOnJoin'),
        rulesTitle: getSetting('rules.title'),
        rulesText: getSetting('rules.text'),
        sugThread: getSetting('suggestions.createThread'),
        sugCooldown: getSetting('suggestions.cooldownSeconds'),
        bugCooldown: getSetting('bugs.cooldownSeconds'),
        reminder: getSetting('testsessions.reminderMinutes'),
      },
      backups: listBackups().slice(0, 10),
    });
  });

  r.post('/settings/channels', requireFeature('settings.manage'), (req, res) =>
    action(req, res, '/settings', async () => {
      const overrides: Record<string, string> = {};
      const keys = [...allChannelSpecs().map((s) => s.key), 'roadmap'];
      for (const k of keys) {
        const v = field.id(req.body, `ch_${k}`);
        const managed = getResource(`channel:${k}`)?.discord_id ?? null;
        if (v && v !== managed) overrides[k] = v;
      }
      setSetting('channels.overrides', overrides);
      await audit({ type: 'admin', action: 'channels', actorId: req.member!.id, message: 'Affectation des salons modifiée depuis le panel.' });
      return 'Salons enregistrés.';
    }),
  );

  r.post('/settings/roles', requireFeature('settings.manage'), (req, res) =>
    action(req, res, '/settings', async () => {
      for (const n of NOTIFICATION_TYPES) {
        const v = field.id(req.body, `notif_${n.key}`);
        if (v) setResource(`role:${n.role}`, 'role', v);
      }
      const m = field.id(req.body, 'memberRole');
      if (m) setResource('role:member', 'role', m);
      await audit({ type: 'admin', action: 'roles', actorId: req.member!.id, message: 'Rôles de notification/membre modifiés depuis le panel.' });
      return 'Rôles enregistrés.';
    }),
  );

  r.post('/settings/general', requireFeature('settings.manage'), (req, res) =>
    action(req, res, '/settings', async () => {
      setSetting('members.autoroleOnJoin', field.bool(req.body, 'autorole'));
      setSetting('rules.title', field.str(req.body, 'rulesTitle', 200) || 'Règlement');
      setSetting('rules.text', field.str(req.body, 'rulesText', 3800));
      setSetting('suggestions.createThread', field.bool(req.body, 'sugThread'));
      setSetting('suggestions.cooldownSeconds', field.int(req.body, 'sugCooldown', 0, 86400) ?? 300);
      setSetting('bugs.cooldownSeconds', field.int(req.body, 'bugCooldown', 0, 86400) ?? 120);
      setSetting('testsessions.reminderMinutes', field.int(req.body, 'reminder', 1, 1440) ?? 30);
      const enabled: Record<string, boolean> = {};
      for (const k of Object.keys(LOG_TYPES)) enabled[k] = field.bool(req.body, `log_${k}`);
      setSetting('logs.enabled', enabled);
      await audit({ type: 'admin', action: 'settings', actorId: req.member!.id, message: 'Réglages généraux modifiés depuis le panel.' });
      return 'Réglages enregistrés.';
    }),
  );

  r.post('/settings/panels', requireFeature('settings.manage'), (req, res) =>
    action(req, res, '/settings', async () => {
      const report = await publishAllPanels();
      const failed = report.filter((x) => x.startsWith('⛔'));
      if (failed.length) throw new FormError(report.join(' • '));
      return `Panneaux publiés : ${report.join(' • ')}`;
    }),
  );

  r.post('/settings/backup', requireFeature('settings.manage'), (req, res) =>
    action(req, res, '/settings', async () => {
      const f = await backupDatabase();
      return `Sauvegarde créée : ${f.split('/').pop()}`;
    }),
  );

  // ───────────── Permissions ─────────────
  r.get('/permissions', requireFeature('permissions'), (_req, res) => {
    const groups = new Map<string, { key: Feature; label: string; roles: string[]; custom: boolean }[]>();
    for (const f of Object.keys(FEATURES) as Feature[]) {
      const g = FEATURES[f].group;
      groups.set(g, [...(groups.get(g) ?? []), { key: f, label: FEATURES[f].label, roles: featureRoleIds(f), custom: isFeatureCustomized(f) }]);
    }
    res.render('permissions', { title: 'Rôles et permissions', groups: [...groups.entries()], roles: guildRoles() });
  });

  r.post('/permissions', requireFeature('permissions'), (req, res) =>
    action(req, res, '/permissions', async () => {
      const f = field.str(req.body, 'feature', 50);
      if (!isFeature(f)) throw new FormError('Fonctionnalité inconnue.');
      if (field.bool(req.body, 'reset')) setFeatureRoles(f, null);
      else {
        const roles = field.ids(req.body, 'roles');
        if (f === 'panel.access' || f === 'permissions') {
          // Garde-fou : on ne peut pas se retirer soi-même l'accès (sauf super-utilisateur).
          const mine = req.member!.roles.cache;
          const keeps = roles.some((id) => mine.has(id)) || req.member!.guild.ownerId === req.member!.id || req.member!.permissions.has('Administrator');
          if (!keeps) throw new FormError('Tu te retirerais ton propre accès : garde au moins un de tes rôles dans la liste.');
        }
        setFeatureRoles(f, roles);
      }
      await audit({ type: 'admin', action: 'permissions', actorId: req.member!.id, target: f, message: `Permissions « ${FEATURES[f].label} » modifiées depuis le panel.` });
      return `Permissions « ${FEATURES[f].label} » enregistrées.`;
    }),
  );
  return r;
}
