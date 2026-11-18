import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
} from 'discord.js';
import {
  ROADMAP_STATUS,
  TASK_CATEGORIES,
  TASK_PRIORITY,
  TASK_STATUS,
  VERSION_STATUS,
  isKeyOf,
  statusOptions,
  type RoadmapStatus,
  type TaskPriority,
  type TaskStatus,
  type VersionStatus,
} from '../../config/constants';
import type { BotModule, ComponentInteraction } from '../../bot/types';
import { cid } from '../../bot/types';
import { deferEphemeral, ephemeral, fail, openModal, requireFeature } from '../../bot/reply';
import { brandEmbed, warnEmbed } from '../../bot/ui/embeds';
import { discordTs, parseDate, toFrInput } from '../../core/time';
import { progressBar, splitLines, truncate } from '../../core/text';
import { audit } from '../logs/audit';
import { featuresOf, roadmap, tasks, versions } from './dev.repo';
import {
  deleteTask,
  deleteVersion,
  normalizeRoadmap,
  roadmapChannelId,
  scheduleRoadmapSync,
  scheduleTaskSync,
  setTaskStatus,
  syncRoadmap,
  syncTask,
  syncVersion,
} from './dev.service';

// ───────────── Versions : /release ─────────────

export function versionModal(customId: string, v?: { version: string; name: string; description: string; features: string[]; target_date: number | null }) {
  const t = (id: string, style: TextInputStyle, required: boolean, max: number, value?: string, placeholder?: string) => {
    const x = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(required).setMaxLength(max);
    if (value) x.setValue(value.slice(0, max));
    if (placeholder) x.setPlaceholder(placeholder);
    return x;
  };
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(v ? `Modifier ${v.version}` : 'Nouvelle version')
    .addLabelComponents(
      new LabelBuilder().setLabel('Numéro de version').setTextInputComponent(t('version', TextInputStyle.Short, true, 20, v?.version, 'V0.1')),
      new LabelBuilder().setLabel('Nom').setTextInputComponent(t('name', TextInputStyle.Short, true, 100, v?.name, 'Combat System')),
      new LabelBuilder().setLabel('Description').setTextInputComponent(t('description', TextInputStyle.Paragraph, false, 1500, v?.description)),
      new LabelBuilder()
        .setLabel('Fonctionnalités prévues (une par ligne)')
        .setDescription('Préfixe « [x] » pour marquer une fonctionnalité terminée')
        .setTextInputComponent(t('features', TextInputStyle.Paragraph, false, 2000, v?.features.join('\n'), '[x] Combo de base\nGarde et contre')),
      new LabelBuilder().setLabel('Date prévisionnelle (facultatif)').setDescription('JJ/MM/AAAA').setTextInputComponent(t('date', TextInputStyle.Short, false, 20, toFrInput(v?.target_date ?? null, false))),
    );
}

async function versionAutocomplete(i: AutocompleteInteraction<'cached'>) {
  await i.respond(versions.search(String(i.options.getFocused())).map((v) => ({ name: truncate(`${v.version} — ${v.name}`, 100), value: String(v.id) })));
}

async function handleVersion(i: ComponentInteraction, action: string, args: string[]) {
  if (!(await requireFeature(i, 'dev.manage'))) return;
  if (action === 'save' && i.isModalSubmit()) {
    const editing = args[0] !== 'new' ? versions.get(Number(args[0])) : undefined;
    const status = (args[1] && isKeyOf(VERSION_STATUS, args[1]) ? args[1] : (editing?.status ?? 'planned')) as VersionStatus;
    const progress = args[2] !== undefined && args[2] !== '' ? Number(args[2]) : (editing?.progress ?? null);
    const version = i.fields.getTextInputValue('version').trim();
    const dateRaw = i.fields.getTextInputValue('date').trim();
    const target = dateRaw ? parseDate(dateRaw) : null;
    if (dateRaw && target === null) return fail(i, 'Date invalide (format JJ/MM/AAAA).');
    const other = versions.byVersion(version);
    if (other && other.id !== editing?.id) return fail(i, `La version ${version} existe déjà.`);
    const data = {
      version,
      name: i.fields.getTextInputValue('name').trim(),
      description: i.fields.getTextInputValue('description').trim(),
      features: splitLines(i.fields.getTextInputValue('features')),
      status,
      target_date: target,
      progress,
    };
    await deferEphemeral(i);
    let id: number;
    if (editing) {
      versions.update(editing.id, data);
      id = editing.id;
    } else id = versions.create(data);
    await syncVersion(id);
    await audit({ type: 'roadmap', action: editing ? 'version_edit' : 'version_create', actorId: i.user.id, target: version, message: `Version **${version} — ${data.name}** ${editing ? 'modifiée' : 'créée'}.` });
    const v = versions.get(id)!;
    return ephemeral(i, `Version **${v.version}** ${editing ? 'mise à jour' : 'publiée'}${v.channel_id ? ` dans <#${v.channel_id}>` : ' (salon #release non configuré)'}.`);
  }
  if (action === 'delete' && i.isButton()) {
    await deleteVersion(Number(args[0]), i.user.id);
    return i.update({ embeds: [warnEmbed('Version supprimée.')], components: [] });
  }
}

const releaseCommand = new SlashCommandBuilder()
  .setName('release')
  .setDescription('Versions du jeu (salon #release)')
  .addSubcommand((s) =>
    s
      .setName('create')
      .setDescription('Créer une version')
      .addStringOption((o) => o.setName('statut').setDescription('Statut').addChoices(...statusOptions(VERSION_STATUS)))
      .addIntegerOption((o) => o.setName('progression').setDescription('Progression en %').setMinValue(0).setMaxValue(100)),
  )
  .addSubcommand((s) =>
    s
      .setName('edit')
      .setDescription('Modifier une version')
      .addStringOption((o) => o.setName('version').setDescription('Version').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('statut').setDescription('Nouveau statut').addChoices(...statusOptions(VERSION_STATUS)))
      .addIntegerOption((o) => o.setName('progression').setDescription('Progression en %').setMinValue(0).setMaxValue(100)),
  )
  .addSubcommand((s) =>
    s
      .setName('status')
      .setDescription('Changer rapidement le statut/la progression d’une version')
      .addStringOption((o) => o.setName('version').setDescription('Version').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('statut').setDescription('Statut').addChoices(...statusOptions(VERSION_STATUS)))
      .addIntegerOption((o) => o.setName('progression').setDescription('Progression en %').setMinValue(0).setMaxValue(100)),
  )
  .addSubcommand((s) => s.setName('list').setDescription('Lister les versions'))
  .addSubcommand((s) => s.setName('delete').setDescription('Supprimer une version').addStringOption((o) => o.setName('version').setDescription('Version').setRequired(true).setAutocomplete(true)))
  .addSubcommand((s) => s.setName('sync').setDescription('Republier/mettre à jour tous les messages de version'));

// ───────────── Tâches : /todo ─────────────

const priorityChoices = Object.entries(TASK_PRIORITY).map(([value, p]) => ({ name: `${p.emoji} ${p.label}`, value }));

const todoCommand = new SlashCommandBuilder()
  .setName('todo')
  .setDescription('Tâches de développement (salon #to-do)')
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Ajouter une tâche')
      .addStringOption((o) => o.setName('titre').setDescription('Titre').setRequired(true).setMaxLength(100))
      .addStringOption((o) => o.setName('categorie').setDescription('Catégorie').setAutocomplete(true).setMaxLength(50))
      .addStringOption((o) => o.setName('priorite').setDescription('Priorité').addChoices(...priorityChoices))
      .addUserOption((o) => o.setName('responsable').setDescription('Responsable'))
      .addStringOption((o) => o.setName('echeance').setDescription('Date limite (JJ/MM/AAAA)').setMaxLength(20))
      .addStringOption((o) => o.setName('description').setDescription('Description').setMaxLength(1500)),
  )
  .addSubcommand((s) =>
    s
      .setName('edit')
      .setDescription('Modifier une tâche')
      .addStringOption((o) => o.setName('tache').setDescription('Tâche').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('titre').setDescription('Titre').setMaxLength(100))
      .addStringOption((o) => o.setName('categorie').setDescription('Catégorie').setAutocomplete(true).setMaxLength(50))
      .addStringOption((o) => o.setName('priorite').setDescription('Priorité').addChoices(...priorityChoices))
      .addUserOption((o) => o.setName('responsable').setDescription('Responsable'))
      .addBooleanOption((o) => o.setName('retirer_responsable').setDescription('Retirer le responsable'))
      .addStringOption((o) => o.setName('echeance').setDescription('Date limite (JJ/MM/AAAA, « aucune » pour retirer)').setMaxLength(20))
      .addStringOption((o) => o.setName('description').setDescription('Description').setMaxLength(1500)),
  )
  .addSubcommand((s) =>
    s
      .setName('status')
      .setDescription('Changer le statut d’une tâche')
      .addStringOption((o) => o.setName('tache').setDescription('Tâche').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('statut').setDescription('Statut').setRequired(true).addChoices(...statusOptions(TASK_STATUS))),
  )
  .addSubcommand((s) => s.setName('list').setDescription('Vue d’ensemble des tâches').addStringOption((o) => o.setName('statut').setDescription('Filtrer').addChoices(...statusOptions(TASK_STATUS))))
  .addSubcommand((s) => s.setName('remove').setDescription('Supprimer une tâche').addStringOption((o) => o.setName('tache').setDescription('Tâche').setRequired(true).setAutocomplete(true)));

async function todoAutocomplete(i: AutocompleteInteraction<'cached'>) {
  const focused = i.options.getFocused(true);
  if (focused.name === 'categorie') {
    const all = [...new Set([...TASK_CATEGORIES, ...tasks.categories()])].filter((c) => c.toLowerCase().includes(focused.value.toLowerCase()));
    return i.respond(all.slice(0, 25).map((c) => ({ name: c, value: c })));
  }
  return i.respond(tasks.search(focused.value).map((t) => ({ name: truncate(`#${t.id} ${TASK_STATUS[t.status].emoji} ${t.title}`, 100), value: String(t.id) })));
}

// ───────────── Roadmap : /roadmap ─────────────

const roadmapStatusChoices = statusOptions(ROADMAP_STATUS);
const roadmapCommand = new SlashCommandBuilder()
  .setName('roadmap')
  .setDescription('Roadmap du jeu')
  .addSubcommand((s) => s.setName('view').setDescription('Voir la roadmap'))
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Ajouter une fonctionnalité')
      .addStringOption((o) => o.setName('categorie').setDescription('Catégorie').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('titre').setDescription('Titre').setRequired(true).setMaxLength(100))
      .addStringOption((o) => o.setName('description').setDescription('Description').setMaxLength(500))
      .addStringOption((o) => o.setName('statut').setDescription('Statut').addChoices(...roadmapStatusChoices))
      .addIntegerOption((o) => o.setName('progression').setDescription('Progression en %').setMinValue(0).setMaxValue(100))
      .addStringOption((o) => o.setName('date').setDescription('Date prévisionnelle (JJ/MM/AAAA)').setMaxLength(20)),
  )
  .addSubcommand((s) =>
    s
      .setName('edit')
      .setDescription('Modifier une fonctionnalité')
      .addStringOption((o) => o.setName('element').setDescription('Fonctionnalité').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('titre').setDescription('Titre').setMaxLength(100))
      .addStringOption((o) => o.setName('description').setDescription('Description').setMaxLength(500))
      .addStringOption((o) => o.setName('categorie').setDescription('Déplacer vers la catégorie').setAutocomplete(true))
      .addStringOption((o) => o.setName('date').setDescription('Date prévisionnelle (JJ/MM/AAAA, « aucune » pour retirer)').setMaxLength(20)),
  )
  .addSubcommand((s) => s.setName('remove').setDescription('Retirer une fonctionnalité').addStringOption((o) => o.setName('element').setDescription('Fonctionnalité').setRequired(true).setAutocomplete(true)))
  .addSubcommand((s) =>
    s
      .setName('status')
      .setDescription('Changer le statut')
      .addStringOption((o) => o.setName('element').setDescription('Fonctionnalité').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('statut').setDescription('Statut').setRequired(true).addChoices(...roadmapStatusChoices)),
  )
  .addSubcommand((s) =>
    s
      .setName('progress')
      .setDescription('Changer la progression')
      .addStringOption((o) => o.setName('element').setDescription('Fonctionnalité').setRequired(true).setAutocomplete(true))
      .addIntegerOption((o) => o.setName('valeur').setDescription('Progression en %').setRequired(true).setMinValue(0).setMaxValue(100)),
  )
  .addSubcommand((s) =>
    s
      .setName('publish')
      .setDescription('Publier/mettre à jour la roadmap dans Discord')
      .addBooleanOption((o) => o.setName('reinitialiser').setDescription('Supprimer et republier tous les messages dans l’ordre')),
  );

async function roadmapAutocomplete(i: AutocompleteInteraction<'cached'>) {
  const focused = i.options.getFocused(true);
  if (focused.name === 'categorie') {
    return i.respond(
      roadmap
        .categories()
        .filter((c) => c.name.toLowerCase().includes(focused.value.toLowerCase()))
        .slice(0, 25)
        .map((c) => ({ name: `${c.emoji ?? ''} ${c.name}`.trim(), value: String(c.id) })),
    );
  }
  return i.respond(roadmap.searchItems(focused.value).map((it) => ({ name: truncate(`${ROADMAP_STATUS[it.status].emoji} ${it.title} (${it.category_name}) — ${it.progress}%`, 100), value: String(it.id) })));
}

function parseOptionalDate(raw: string | null): { ok: true; value: number | null | undefined } | { ok: false } {
  if (raw === null) return { ok: true, value: undefined };
  if (['aucune', 'aucun', 'none', '-'].includes(raw.trim().toLowerCase())) return { ok: true, value: null };
  const v = parseDate(raw);
  return v === null ? { ok: false } : { ok: true, value: v };
}

export const devModule: BotModule = {
  name: 'dev',
  components: [
    { prefix: 'ver', handle: handleVersion },
    {
      prefix: 'task',
      async handle(i, action, args) {
        if (!(await requireFeature(i, 'tasks.manage'))) return;
        if (action === 'status' && i.isButton()) {
          const status = args[1];
          if (!isKeyOf(TASK_STATUS, status)) return fail(i, 'Statut inconnu.');
          await i.deferUpdate();
          const t = await setTaskStatus(Number(args[0]), status, i.user.id);
          if (!t) return fail(i, 'Tâche introuvable.');
          return ephemeral(i, `Tâche **${t.title}** → ${TASK_STATUS[status].emoji} ${TASK_STATUS[status].label}`);
        }
      },
    },
  ],
  commands: [
    {
      data: releaseCommand,
      feature: 'dev.manage',
      category: '🧪 Développement',
      help: [{ usage: '/release create|edit|status|list|delete|sync', description: 'Gérer les versions du jeu dans #release', feature: 'dev.manage' }],
      autocomplete: versionAutocomplete,
      async execute(i) {
        const sub = i.options.getSubcommand();
        const status = i.options.getString('statut') ?? '';
        const progress = i.options.getInteger('progression');
        if (sub === 'create') return openModal(i, versionModal(cid('ver', 'save', 'new', status, progress ?? '')));
        if (sub === 'list') {
          const list = versions.list();
          const e = brandEmbed({ title: '🚀 Versions', description: list.length ? undefined : 'Aucune version. Crée-en une avec /release create.' });
          for (const v of list.slice(0, 25)) {
            const st = VERSION_STATUS[v.status];
            e.addFields({ name: `${st.emoji} ${v.version} — ${v.name}`, value: `${st.label}${v.target_date ? ` • ${discordTs(v.target_date, 'D')}` : ''}${v.progress !== null ? ` • ${v.progress}%` : ''} • ${featuresOf(v).length} fonctionnalité(s)` });
          }
          return ephemeral(i, e);
        }
        if (sub === 'sync') {
          await deferEphemeral(i);
          for (const v of versions.list()) await syncVersion(v.id);
          return ephemeral(i, 'Messages de version synchronisés.');
        }
        const v = versions.get(Number(i.options.getString('version', true)));
        if (!v) return fail(i, 'Version introuvable.');
        if (sub === 'edit') return openModal(i, versionModal(cid('ver', 'save', v.id, status, progress ?? ''), { ...v, features: featuresOf(v) }));
        if (sub === 'status') {
          if (!status && progress === null) return fail(i, 'Indique un statut et/ou une progression.');
          versions.update(v.id, { status: (status || v.status) as VersionStatus, progress: progress ?? v.progress });
          await deferEphemeral(i);
          await syncVersion(v.id);
          await audit({ type: 'roadmap', action: 'version_status', actorId: i.user.id, target: v.version, message: `Version ${v.version} : ${status ? VERSION_STATUS[status as VersionStatus].label : ''}${progress !== null ? ` ${progress}%` : ''}.` });
          return ephemeral(i, `Version **${v.version}** mise à jour.`);
        }
        if (sub === 'delete') {
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(cid('ver', 'delete', v.id)).setLabel('Supprimer').setStyle(ButtonStyle.Danger));
          return ephemeral(i, { embeds: [warnEmbed(`Supprimer la version **${v.version} — ${v.name}** et son message ?`)], components: [row] });
        }
      },
    },
    {
      data: todoCommand,
      feature: 'tasks.manage',
      category: '🧪 Développement',
      help: [{ usage: '/todo add|edit|status|list|remove', description: 'Gérer les tâches dans #to-do', feature: 'tasks.manage' }],
      autocomplete: todoAutocomplete,
      async execute(i) {
        const sub = i.options.getSubcommand();
        if (sub === 'list') {
          const filter = i.options.getString('statut') ?? undefined;
          const list = tasks.list(filter);
          const counts = tasks.counts();
          const e = brandEmbed({
            title: '📝 Tâches de développement',
            description: Object.entries(TASK_STATUS).map(([k, s]) => `${s.emoji} ${s.label} : **${counts[k] ?? 0}**`).join(' • '),
          });
          const groups = new Map<string, string[]>();
          for (const t of list) {
            const key = TASK_STATUS[t.status].emoji + ' ' + TASK_STATUS[t.status].label;
            groups.set(key, [...(groups.get(key) ?? []), `\`#${t.id}\` ${TASK_PRIORITY[t.priority].emoji} ${t.title}${t.assignee_id ? ` — <@${t.assignee_id}>` : ''}${t.due_date ? ` • ${discordTs(t.due_date, 'd')}` : ''}`]);
          }
          for (const [k, lines] of groups) e.addFields({ name: k, value: truncate(lines.join('\n'), 1024) });
          return ephemeral(i, e);
        }
        if (sub === 'add') {
          const due = parseOptionalDate(i.options.getString('echeance'));
          if (!due.ok) return fail(i, 'Date limite invalide (JJ/MM/AAAA).');
          await deferEphemeral(i);
          const id = tasks.create({
            title: i.options.getString('titre', true),
            description: i.options.getString('description') ?? '',
            category: i.options.getString('categorie') ?? 'Général',
            priority: (i.options.getString('priorite') ?? 'medium') as TaskPriority,
            assignee_id: i.options.getUser('responsable')?.id ?? null,
            due_date: due.value ?? null,
            created_by: i.user.id,
          });
          await syncTask(id);
          const t = tasks.get(id)!;
          await audit({ type: 'tasks', action: 'create', actorId: i.user.id, target: `Tâche n°${id}`, message: `Tâche « ${t.title} » créée.` });
          return ephemeral(i, `Tâche **#${id} ${t.title}** ajoutée${t.channel_id ? ` dans <#${t.channel_id}>` : ' (salon #to-do non configuré)'}.`);
        }
        const t = tasks.get(Number(i.options.getString('tache', true).replace('#', '')));
        if (!t) return fail(i, 'Tâche introuvable.');
        if (sub === 'status') {
          await deferEphemeral(i);
          await setTaskStatus(t.id, i.options.getString('statut', true) as TaskStatus, i.user.id);
          return ephemeral(i, 'Statut mis à jour.');
        }
        if (sub === 'remove') {
          await deferEphemeral(i);
          await deleteTask(t.id, i.user.id);
          return ephemeral(i, `Tâche « ${t.title} » supprimée.`);
        }
        if (sub === 'edit') {
          const due = parseOptionalDate(i.options.getString('echeance'));
          if (!due.ok) return fail(i, 'Date limite invalide (JJ/MM/AAAA).');
          tasks.update(t.id, {
            title: i.options.getString('titre') ?? undefined,
            description: i.options.getString('description') ?? undefined,
            category: i.options.getString('categorie') ?? undefined,
            priority: (i.options.getString('priorite') as TaskPriority) ?? undefined,
            assignee_id: i.options.getBoolean('retirer_responsable') ? null : (i.options.getUser('responsable')?.id ?? undefined),
            due_date: due.value,
          });
          scheduleTaskSync(t.id);
          await audit({ type: 'tasks', action: 'edit', actorId: i.user.id, target: `Tâche n°${t.id}`, message: `Tâche « ${t.title} » modifiée.` });
          return ephemeral(i, 'Tâche mise à jour.');
        }
      },
    },
    {
      data: roadmapCommand,
      category: '🧪 Développement',
      help: [
        { usage: '/roadmap view', description: 'Voir la roadmap' },
        { usage: '/roadmap add|edit|remove|status|progress|publish', description: 'Gérer la roadmap', feature: 'dev.manage' },
      ],
      autocomplete: roadmapAutocomplete,
      async execute(i) {
        const sub = i.options.getSubcommand();
        if (sub === 'view') {
          const cats = roadmap.categories();
          const e = brandEmbed({ title: '🗺️ Roadmap', description: roadmapChannelId() ? `Version complète dans <#${roadmapChannelId()}>` : undefined });
          for (const c of cats.slice(0, 25)) {
            const items = roadmap.items(c.id);
            const avg = items.length ? items.reduce((n, x) => n + x.progress, 0) / items.length : 0;
            e.addFields({
              name: `${c.emoji ?? '📁'} ${c.name} — ${Math.round(avg)}%`,
              value: truncate(items.map((x) => `${ROADMAP_STATUS[x.status].emoji} ${x.title} (${x.progress}%)`).join('\n') || '—', 1024),
            });
          }
          return ephemeral(i, e);
        }
        if (!(await requireFeature(i, 'dev.manage'))) return;
        if (sub === 'publish') {
          await deferEphemeral(i);
          await syncRoadmap(i.options.getBoolean('reinitialiser') ?? false);
          return ephemeral(i, `Roadmap publiée dans <#${roadmapChannelId()}>.`);
        }
        if (sub === 'add') {
          const cat = roadmap.category(Number(i.options.getString('categorie', true)));
          if (!cat) return fail(i, 'Catégorie introuvable : choisis-la dans la liste.');
          const date = parseOptionalDate(i.options.getString('date'));
          if (!date.ok) return fail(i, 'Date invalide (JJ/MM/AAAA).');
          const n = normalizeRoadmap((i.options.getString('statut') ?? 'upcoming') as RoadmapStatus, i.options.getInteger('progression') ?? 0);
          const id = roadmap.createItem({ category_id: cat.id, title: i.options.getString('titre', true), description: i.options.getString('description') ?? '', ...n, target_date: date.value ?? null });
          scheduleRoadmapSync();
          await audit({ type: 'roadmap', action: 'item_create', actorId: i.user.id, target: cat.name, message: `Roadmap : « ${roadmap.item(id)!.title} » ajouté dans ${cat.name}.` });
          return ephemeral(i, `Fonctionnalité ajoutée à **${cat.name}**. La roadmap Discord est mise à jour.`);
        }
        const it = roadmap.item(Number(i.options.getString('element', true)));
        if (!it) return fail(i, 'Fonctionnalité introuvable : choisis-la dans la liste.');
        if (sub === 'remove') {
          roadmap.removeItem(it.id);
          scheduleRoadmapSync();
          await audit({ type: 'roadmap', action: 'item_delete', actorId: i.user.id, message: `Roadmap : « ${it.title} » retiré.` });
          return ephemeral(i, `« ${it.title} » retiré de la roadmap.`);
        }
        if (sub === 'status' || sub === 'progress') {
          const status = sub === 'status' ? (i.options.getString('statut', true) as RoadmapStatus) : it.status;
          const progress = sub === 'progress' ? i.options.getInteger('valeur', true) : status === 'done' ? 100 : it.progress;
          const n = normalizeRoadmap(status, progress);
          roadmap.updateItem(it.id, n);
          scheduleRoadmapSync();
          await audit({ type: 'roadmap', action: 'item_status', actorId: i.user.id, message: `Roadmap : « ${it.title} » → ${ROADMAP_STATUS[n.status].label} (${n.progress}%).` });
          return ephemeral(i, `« ${it.title} » : ${ROADMAP_STATUS[n.status].emoji} ${ROADMAP_STATUS[n.status].label} • ${progressBar(n.progress)}`);
        }
        if (sub === 'edit') {
          const date = parseOptionalDate(i.options.getString('date'));
          if (!date.ok) return fail(i, 'Date invalide (JJ/MM/AAAA).');
          const catRaw = i.options.getString('categorie');
          const cat = catRaw ? roadmap.category(Number(catRaw)) : undefined;
          if (catRaw && !cat) return fail(i, 'Catégorie introuvable.');
          roadmap.updateItem(it.id, { title: i.options.getString('titre') ?? undefined, description: i.options.getString('description') ?? undefined, category_id: cat?.id, target_date: date.value });
          scheduleRoadmapSync();
          await audit({ type: 'roadmap', action: 'item_edit', actorId: i.user.id, message: `Roadmap : « ${it.title} » modifié.` });
          return ephemeral(i, 'Fonctionnalité mise à jour.');
        }
      },
    },
  ],
};
