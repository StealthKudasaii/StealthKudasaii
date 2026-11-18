import { Router } from 'express';
import { ROADMAP_STATUS, TASK_CATEGORIES, TASK_PRIORITY, TASK_STATUS, VERSION_STATUS, type RoadmapStatus, type TaskPriority, type TaskStatus, type VersionStatus } from '../../config/constants';
import { featuresOf, roadmap, tasks, versions } from '../../modules/dev/dev.repo';
import {
  deleteRoadmapCategory,
  deleteTask,
  deleteVersion,
  normalizeRoadmap,
  roadmapChannelId,
  scheduleRoadmapSync,
  setTaskStatus,
  syncRoadmap,
  syncTask,
  syncVersion,
} from '../../modules/dev/dev.service';
import { audit } from '../../modules/logs/audit';
import { splitLines } from '../../core/text';
import { requireFeature } from '../middleware';
import { action, field, FormError } from '../helpers';
import { tryGetGuild } from '../../bot/client';

const keys = <T extends object>(o: T) => Object.keys(o) as (keyof T & string)[];

function staffMembers(): { id: string; name: string }[] {
  const g = tryGetGuild();
  if (!g) return [];
  return [...g.members.cache.values()]
    .filter((m) => !m.user.bot && m.roles.cache.size > 1)
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .slice(0, 300)
    .map((m) => ({ id: m.id, name: m.displayName }));
}

export function devRouter(): Router {
  const r = Router();

  // ───────────── Versions ─────────────
  r.get('/dev/versions', requireFeature('dev.manage'), (_req, res) => {
    res.render('versions', { title: 'Versions', list: versions.list().map((v) => ({ ...v, featuresText: featuresOf(v).join('\n') })) });
  });

  r.post('/dev/versions', requireFeature('dev.manage'), (req, res) =>
    action(req, res, '/dev/versions', async () => {
      const id = field.int(req.body, 'id', 1, 1e9);
      if (id && field.bool(req.body, 'delete')) {
        await deleteVersion(id, req.member!.id);
        return 'Version supprimée.';
      }
      const version = field.str(req.body, 'version', 20);
      const name = field.str(req.body, 'name', 100);
      if (!version || !name) throw new FormError('Numéro et nom obligatoires.');
      const other = versions.byVersion(version);
      if (other && other.id !== id) throw new FormError('Cette version existe déjà.');
      const data = {
        version,
        name,
        description: field.str(req.body, 'description', 1500),
        features: splitLines(field.str(req.body, 'features', 3000)),
        status: field.oneOf(req.body, 'status', keys(VERSION_STATUS)) as VersionStatus,
        target_date: field.date(req.body, 'target_date'),
        progress: field.int(req.body, 'progress', 0, 100),
      };
      const vid = id ?? versions.create(data);
      if (id) versions.update(id, data);
      await syncVersion(vid);
      await audit({ type: 'roadmap', action: id ? 'version_edit' : 'version_create', actorId: req.member!.id, target: version, message: `Version ${version} ${id ? 'modifiée' : 'créée'} depuis le panel.` });
      return `Version ${version} enregistrée et publiée.`;
    }),
  );

  // ───────────── Tâches ─────────────
  r.get('/dev/tasks', requireFeature('tasks.manage'), (req, res) => {
    const status = Object.prototype.hasOwnProperty.call(TASK_STATUS, String(req.query.status)) ? String(req.query.status) : undefined;
    res.render('tasks', {
      title: 'Tâches',
      list: tasks.list(status),
      status,
      counts: tasks.counts(),
      categories: [...new Set([...TASK_CATEGORIES, ...tasks.categories()])],
      members: staffMembers(),
    });
  });

  r.post('/dev/tasks', requireFeature('tasks.manage'), (req, res) =>
    action(req, res, req.get('referer')?.includes('/dev/tasks') ? req.get('referer')! : '/dev/tasks', async () => {
      const id = field.int(req.body, 'id', 1, 1e9);
      const op = field.oneOf(req.body, 'op', ['save', 'delete', 'status'] as const, 'save');
      if (id && op === 'delete') {
        await deleteTask(id, req.member!.id);
        return 'Tâche supprimée.';
      }
      if (id && op === 'status') {
        await setTaskStatus(id, field.oneOf(req.body, 'status', keys(TASK_STATUS)) as TaskStatus, req.member!.id);
        return 'Statut mis à jour.';
      }
      const title = field.str(req.body, 'title', 100);
      if (!title) throw new FormError('Le titre est obligatoire.');
      const data = {
        title,
        description: field.str(req.body, 'description', 1500),
        category: field.str(req.body, 'category', 50) || 'Général',
        priority: field.oneOf(req.body, 'priority', keys(TASK_PRIORITY), 'medium') as TaskPriority,
        assignee_id: field.id(req.body, 'assignee'),
        due_date: field.date(req.body, 'due_date'),
      };
      let tid = id;
      if (id) {
        const status = field.oneOf(req.body, 'status', keys(TASK_STATUS)) as TaskStatus;
        const before = tasks.get(id);
        tasks.update(id, { ...data, status, completed_at: status === 'done' ? (before?.completed_at ?? Date.now()) : null });
      } else tid = tasks.create({ ...data, created_by: req.member!.id });
      await syncTask(tid!);
      await audit({ type: 'tasks', action: id ? 'edit' : 'create', actorId: req.member!.id, target: `Tâche n°${tid}`, message: `Tâche « ${title} » ${id ? 'modifiée' : 'créée'} depuis le panel.` });
      return 'Tâche enregistrée et publiée.';
    }),
  );

  // ───────────── Roadmap ─────────────
  r.get('/dev/roadmap', requireFeature('dev.manage'), (_req, res) => {
    res.render('roadmap', {
      title: 'Roadmap',
      categories: roadmap.categories().map((c) => ({ ...c, items: roadmap.items(c.id) })),
      channel: roadmapChannelId(),
    });
  });

  r.post('/dev/roadmap/publish', requireFeature('dev.manage'), (req, res) =>
    action(req, res, '/dev/roadmap', async () => {
      await syncRoadmap(field.bool(req.body, 'reset'));
      return 'Roadmap publiée sur Discord.';
    }),
  );

  r.post('/dev/roadmap/categories', requireFeature('dev.manage'), (req, res) =>
    action(req, res, '/dev/roadmap', async () => {
      const id = field.int(req.body, 'id', 1, 1e9);
      if (id && field.bool(req.body, 'delete')) {
        await deleteRoadmapCategory(id);
        return 'Catégorie supprimée (et ses fonctionnalités).';
      }
      const name = field.str(req.body, 'name', 80);
      if (!name) throw new FormError('Le nom est obligatoire.');
      const other = roadmap.categoryByName(name);
      if (other && other.id !== id) throw new FormError('Cette catégorie existe déjà.');
      if (id) roadmap.updateCategory(id, { name, emoji: field.optStr(req.body, 'emoji', 10), position: field.int(req.body, 'position', 0, 999) ?? 0 });
      else roadmap.createCategory(name, field.optStr(req.body, 'emoji', 10));
      scheduleRoadmapSync();
      await audit({ type: 'roadmap', action: 'category', actorId: req.member!.id, message: `Catégorie de roadmap « ${name} » enregistrée.` });
      return 'Catégorie enregistrée.';
    }),
  );

  r.post('/dev/roadmap/items', requireFeature('dev.manage'), (req, res) =>
    action(req, res, '/dev/roadmap', async () => {
      const id = field.int(req.body, 'id', 1, 1e9);
      if (id && field.bool(req.body, 'delete')) {
        roadmap.removeItem(id);
        scheduleRoadmapSync();
        return 'Fonctionnalité retirée.';
      }
      const title = field.str(req.body, 'title', 100);
      const category = field.int(req.body, 'category_id', 1, 1e9);
      if (!title || !category || !roadmap.category(category)) throw new FormError('Titre et catégorie obligatoires.');
      const n = normalizeRoadmap(field.oneOf(req.body, 'status', keys(ROADMAP_STATUS)) as RoadmapStatus, field.int(req.body, 'progress', 0, 100) ?? 0);
      const data = { category_id: category, title, description: field.str(req.body, 'description', 500), target_date: field.date(req.body, 'target_date'), ...n };
      if (id) roadmap.updateItem(id, { ...data, position: field.int(req.body, 'position', 0, 999) ?? undefined });
      else roadmap.createItem(data);
      scheduleRoadmapSync();
      await audit({ type: 'roadmap', action: id ? 'item_edit' : 'item_create', actorId: req.member!.id, message: `Roadmap : « ${title} » ${id ? 'modifié' : 'ajouté'} depuis le panel.` });
      return 'Fonctionnalité enregistrée. La roadmap Discord se met à jour.';
    }),
  );

  return r;
}
