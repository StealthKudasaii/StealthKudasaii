import {
  CategoryChannel,
  ChannelType,
  Guild,
  GuildBasedChannel,
  OverwriteType,
  PermissionFlagsBits,
  Role,
  type PermissionOverwriteOptions,
} from 'discord.js';
import {
  CATEGORY_SPECS,
  ROLE_SPECS,
  presetOverwrites,
  type CategorySpec,
  type ChannelSpec,
  type OverwriteSpec,
  type RoleKey,
  type RoleSpec,
} from '../../config/layout';
import { deleteResource, getResource, listResources, setResource } from '../../core/resources';
import { normalizeName } from '../../core/text';
import { childLogger } from '../../core/logger';
import { db } from '../../db';

const log = childLogger('setup');
const REASON = 'RBKS PVP — /setup';

/** Nom lisible d'une permission (pour les récapitulatifs). */
const PERM_NAMES = new Map<bigint, string>(Object.entries(PermissionFlagsBits).map(([k, v]) => [v, k]));
export const permName = (p: bigint) => PERM_NAMES.get(p) ?? p.toString();

export type PlanAction = 'create' | 'fix' | 'ok' | 'adopt' | 'skip';

export interface PlanItem {
  kind: 'role' | 'category' | 'channel' | 'order' | 'member';
  key: string;
  name: string;
  action: PlanAction;
  details: string[];
}

export interface SetupResult {
  items: PlanItem[];
  warnings: string[];
  errors: string[];
}

function findRole(guild: Guild, spec: RoleSpec): Role | null {
  const res = getResource(`role:${spec.key}`);
  if (res) {
    const r = guild.roles.cache.get(res.discord_id);
    if (r) return r;
  }
  const names = [spec.name, ...(spec.aliases ?? [])].map(normalizeName);
  return guild.roles.cache.find((r) => !r.managed && r.id !== guild.id && names.includes(normalizeName(r.name))) ?? null;
}

function findCategory(guild: Guild, spec: CategorySpec): CategoryChannel | null {
  const res = getResource(`category:${spec.key}`);
  if (res) {
    const c = guild.channels.cache.get(res.discord_id);
    if (c?.type === ChannelType.GuildCategory) return c;
  }
  const names = [spec.name, ...(spec.aliases ?? [])].map(normalizeName);
  return (guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && names.includes(normalizeName(c.name))) as CategoryChannel) ?? null;
}

function findChannel(guild: Guild, spec: ChannelSpec, parentId: string | null): GuildBasedChannel | null {
  const res = getResource(`channel:${spec.key}`);
  if (res) {
    const c = guild.channels.cache.get(res.discord_id);
    if (c && c.type === spec.type) return c;
  }
  const names = [spec.name, ...(spec.aliases ?? [])].map(normalizeName);
  const candidates = guild.channels.cache.filter((c) => c.type === spec.type && names.includes(normalizeName(c.name)));
  return candidates.find((c) => c.parentId === parentId) ?? candidates.first() ?? null;
}

/** Résout une cible d'overwrite en identifiant Discord. */
function resolveTarget(guild: Guild, t: OverwriteSpec['target'], roles: Map<RoleKey, Role>): { id: string; type: OverwriteType } | null {
  if (t === '@everyone') return { id: guild.roles.everyone.id, type: OverwriteType.Role };
  if (t === '@bot') return { id: guild.members.me!.id, type: OverwriteType.Member };
  const r = roles.get(t);
  return r ? { id: r.id, type: OverwriteType.Role } : null;
}

/** Calcule les flags manquants d'un salon par rapport au preset. */
function overwriteDiff(channel: GuildBasedChannel | null, guild: Guild, specs: OverwriteSpec[], roles: Map<RoleKey, Role>) {
  const diffs: { id: string; type: OverwriteType; label: string; options: PermissionOverwriteOptions }[] = [];
  for (const spec of specs) {
    const target = resolveTarget(guild, spec.target, roles);
    if (!target) continue;
    const existing = channel && 'permissionOverwrites' in channel ? channel.permissionOverwrites.cache.get(target.id) : undefined;
    const options: PermissionOverwriteOptions = {};
    for (const p of spec.allow) if (!existing?.allow.has(p)) (options as Record<string, boolean>)[permName(p)] = true;
    for (const p of spec.deny) if (!existing?.deny.has(p)) (options as Record<string, boolean>)[permName(p)] = false;
    if (Object.keys(options).length) {
      const label = spec.target === '@everyone' ? '@everyone' : spec.target === '@bot' ? 'bot' : (roles.get(spec.target)?.name ?? spec.target);
      diffs.push({ ...target, label, options });
    }
  }
  // Le bot doit d'abord se donner accès au salon avant de modifier les autres permissions.
  return diffs.sort((a, b) => (a.type === OverwriteType.Member ? -1 : b.type === OverwriteType.Member ? 1 : 0));
}

function toCreateOverwrites(guild: Guild, specs: OverwriteSpec[], roles: Map<RoleKey, Role>) {
  return specs
    .map((s) => {
      const t = resolveTarget(guild, s.target, roles);
      return t ? { id: t.id, type: t.type, allow: s.allow, deny: s.deny } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
}

/**
 * Parcourt la structure cible. En mode aperçu (`apply = false`), aucune modification n'est faite :
 * le même code produit l'aperçu et l'application, ce qui garantit que l'aperçu est fidèle.
 */
export async function runSetup(guild: Guild, apply: boolean): Promise<SetupResult> {
  const result: SetupResult = { items: [], warnings: [], errors: [] };
  await guild.roles.fetch();
  await guild.channels.fetch();
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const botTop = me.roles.highest.position;

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles) || !me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    result.errors.push('Le bot doit avoir les permissions « Gérer les rôles » et « Gérer les salons ». Réinvite-le avec le lien généré par `npm run invite`.');
    return result;
  }

  // ───────────── Rôles ─────────────
  const roles = new Map<RoleKey, Role>();
  for (const spec of ROLE_SPECS) {
    const grantable = spec.permissions.filter((p) => me.permissions.has(p));
    const notGrantable = spec.permissions.filter((p) => !me.permissions.has(p));
    let role = findRole(guild, spec);
    const item: PlanItem = { kind: 'role', key: spec.key, name: spec.name, action: 'ok', details: [] };

    if (!role) {
      item.action = 'create';
      if (apply) {
        try {
          role = await guild.roles.create({
            name: spec.name,
            colors: { primaryColor: spec.color },
            hoist: spec.hoist,
            mentionable: spec.mentionable,
            permissions: grantable,
            reason: REASON,
          });
          setResource(`role:${spec.key}`, 'role', role.id);
        } catch (e) {
          result.errors.push(`Création du rôle ${spec.name} impossible : ${(e as Error).message}`);
        }
      }
    } else {
      if (!getResource(`role:${spec.key}`)) {
        item.action = 'adopt';
        item.details.push(`rôle existant « ${role.name} » repris`);
        if (apply) setResource(`role:${spec.key}`, 'role', role.id);
      }
      const missing = grantable.filter((p) => !role!.permissions.has(p));
      if (missing.length) {
        if (role.position >= botTop) {
          result.warnings.push(`${role.name} est au-dessus du bot : permissions non corrigées (${missing.map(permName).join(', ')}).`);
        } else {
          if (item.action === 'ok') item.action = 'fix';
          item.details.push(`permissions ajoutées : ${missing.map(permName).join(', ')}`);
          if (apply) {
            try {
              await role.setPermissions(role.permissions.add(missing), REASON);
            } catch (e) {
              result.errors.push(`Permissions de ${role.name} : ${(e as Error).message}`);
            }
          }
        }
      }
      if (spec.key !== 'founder' && role.permissions.has(PermissionFlagsBits.Administrator)) {
        result.warnings.push(`${role.name} possède la permission Administrateur : seul 👑 Fondateur devrait l’avoir.`);
      }
    }
    if (notGrantable.length && !(role && notGrantable.every((p) => role!.permissions.has(p)))) {
      const list = notGrantable.map(permName).join(', ');
      result.warnings.push(
        spec.key === 'founder'
          ? `Active manuellement la permission **Administrateur** sur ${spec.name} (le bot ne l’a pas, volontairement, et ne peut donc pas la donner).`
          : `Le bot ne possède pas ${list} : à activer manuellement sur ${spec.name}.`,
      );
    }
    if (role) roles.set(spec.key, role);
    result.items.push(item);
  }

  // Ordre des rôles : on réattribue, dans l'ordre voulu, les positions déjà occupées par les rôles gérés
  // qui sont sous le bot (les autres rôles du serveur ne bougent pas).
  const movable = ROLE_SPECS.map((s) => roles.get(s.key)).filter((r): r is Role => !!r && r.position < botTop);
  const slots = movable.map((r) => r.position).sort((a, b) => b - a);
  const wrong = movable.some((r, idx) => r.position !== slots[idx]);
  if (wrong) {
    result.items.push({ kind: 'order', key: 'order', name: 'Hiérarchie des rôles', action: 'fix', details: ['réorganisation des rôles gérés'] });
    if (apply) {
      try {
        await guild.roles.setPositions(movable.map((r, idx) => ({ role: r.id, position: slots[idx] })));
      } catch (e) {
        result.errors.push(`Réorganisation des rôles impossible : ${(e as Error).message}`);
      }
    }
  }
  const above = ROLE_SPECS.filter((s) => (roles.get(s.key)?.position ?? -1) >= botTop).map((s) => s.name);
  if (above.length) result.warnings.push(`Rôles au-dessus du bot (non modifiables par lui, c’est voulu pour la sécurité) : ${above.join(', ')}.`);

  // Rôle 🤖 Bots attribué aux bots du serveur.
  const botsRole = roles.get('bots');
  if (botsRole && botsRole.position < botTop) {
    const members = await guild.members.fetch().catch(() => guild.members.cache);
    const missingBots = members.filter((m) => m.user.bot && !m.roles.cache.has(botsRole.id));
    if (missingBots.size) {
      result.items.push({ kind: 'member', key: 'bots', name: '🤖 Bots', action: 'fix', details: [`attribution à ${missingBots.size} bot(s)`] });
      if (apply) for (const m of missingBots.values()) await m.roles.add(botsRole, REASON).catch(() => undefined);
    }
  }

  // ───────────── Catégories et salons ─────────────
  for (const cat of CATEGORY_SPECS) {
    let category = findCategory(guild, cat);
    const catItem: PlanItem = { kind: 'category', key: cat.key, name: cat.name, action: 'ok', details: [] };
    const catOverwrites = cat.preset ? presetOverwrites(cat.preset) : [];
    if (!category) {
      catItem.action = 'create';
      if (apply) {
        try {
          category = await guild.channels.create({
            name: cat.name,
            type: ChannelType.GuildCategory,
            permissionOverwrites: toCreateOverwrites(guild, catOverwrites, roles),
            reason: REASON,
          });
          setResource(`category:${cat.key}`, 'category', category.id);
        } catch (e) {
          result.errors.push(`Création de la catégorie ${cat.name} : ${(e as Error).message}`);
        }
      }
    } else {
      if (!getResource(`category:${cat.key}`)) {
        catItem.action = 'adopt';
        if (apply) setResource(`category:${cat.key}`, 'category', category.id);
      }
      const diffs = overwriteDiff(category, guild, catOverwrites, roles);
      if (diffs.length) {
        if (catItem.action === 'ok') catItem.action = 'fix';
        catItem.details.push(`permissions corrigées pour ${diffs.map((d) => d.label).join(', ')}`);
        if (apply) for (const d of diffs) await category.permissionOverwrites.edit(d.id, d.options, { type: d.type, reason: REASON }).catch((e) => result.errors.push(`${cat.name} : ${(e as Error).message}`));
      }
    }
    result.items.push(catItem);

    for (const spec of cat.channels) {
      const overwrites = presetOverwrites(spec.preset);
      let channel = findChannel(guild, spec, category?.id ?? null);
      const item: PlanItem = { kind: 'channel', key: spec.key, name: spec.type === ChannelType.GuildVoice ? `🔊 ${spec.name}` : `#${spec.name}`, action: 'ok', details: [] };
      if (!channel) {
        item.action = 'create';
        if (apply) {
          try {
            channel = await guild.channels.create({
              name: spec.name,
              type: spec.type,
              parent: category?.id,
              topic: spec.type === ChannelType.GuildText ? spec.topic : undefined,
              permissionOverwrites: toCreateOverwrites(guild, overwrites, roles),
              reason: REASON,
            });
            setResource(`channel:${spec.key}`, 'channel', channel.id);
          } catch (e) {
            result.errors.push(`Création de #${spec.name} : ${(e as Error).message}`);
          }
        }
      } else {
        if (!getResource(`channel:${spec.key}`)) {
          item.action = 'adopt';
          item.details.push(`salon existant « ${channel.name} » repris`);
          if (apply) setResource(`channel:${spec.key}`, 'channel', channel.id);
        }
        const diffs = overwriteDiff(channel, guild, overwrites, roles);
        if (diffs.length && 'permissionOverwrites' in channel) {
          if (item.action === 'ok') item.action = 'fix';
          item.details.push(`permissions corrigées pour ${diffs.map((d) => d.label).join(', ')}`);
          if (apply) {
            for (const d of diffs) {
              await channel.permissionOverwrites
                .edit(d.id, d.options, { type: d.type, reason: REASON })
                .catch((e) => result.errors.push(`#${spec.name} : ${(e as Error).message}`));
            }
          }
        }
        if (spec.topic && channel.type === ChannelType.GuildText && !channel.topic) {
          if (item.action === 'ok') item.action = 'fix';
          item.details.push('sujet du salon ajouté');
          if (apply) await channel.setTopic(spec.topic, REASON).catch(() => undefined);
        }
      }
      result.items.push(item);
    }
  }

  log.info({ apply, changes: result.items.filter((i) => i.action !== 'ok').length, errors: result.errors.length }, 'Setup exécuté');
  return result;
}

// ───────────── Nettoyage ─────────────

export interface CleanupItem {
  id: string;
  label: string;
  reason: string;
  /** Suppression côté Discord (sinon uniquement nettoyage de la base). */
  discord: boolean;
}

const knownKeys = () =>
  new Set([
    ...ROLE_SPECS.map((r) => `role:${r.key}`),
    ...CATEGORY_SPECS.map((c) => `category:${c.key}`),
    ...CATEGORY_SPECS.flatMap((c) => c.channels.map((ch) => `channel:${ch.key}`)),
  ]);

/** Liste ce qui peut être nettoyé. Ne concerne QUE des éléments gérés par le bot. */
export async function computeCleanup(guild: Guild): Promise<CleanupItem[]> {
  await guild.roles.fetch();
  await guild.channels.fetch();
  const items: CleanupItem[] = [];
  const known = knownKeys();
  for (const res of listResources()) {
    const exists = res.kind === 'role' ? guild.roles.cache.get(res.discord_id) : guild.channels.cache.get(res.discord_id);
    if (!exists) {
      items.push({ id: `res:${res.key}`, label: res.key, reason: 'supprimé de Discord : référence obsolète en base', discord: false });
    } else if (!known.has(res.key)) {
      items.push({ id: `res:${res.key}`, label: `${exists.name}`, reason: 'élément géré qui ne fait plus partie de la structure', discord: true });
    }
  }
  const archived = db().prepare("SELECT id, channel_id FROM tickets WHERE status = 'closed' AND channel_id IS NOT NULL").all() as { id: number; channel_id: string }[];
  for (const t of archived) {
    const ch = guild.channels.cache.get(t.channel_id);
    if (ch) items.push({ id: `ticket:${t.id}`, label: `#${ch.name}`, reason: `ticket n°${t.id} fermé et archivé`, discord: true });
    else db().prepare('UPDATE tickets SET channel_id = NULL WHERE id = ?').run(t.id);
  }
  const drafts = (db().prepare('SELECT COUNT(*) n FROM application_drafts WHERE updated_at < ?').get(Date.now() - 864e5) as { n: number }).n;
  if (drafts) items.push({ id: 'drafts', label: `${drafts} brouillon(s) de candidature`, reason: 'brouillons abandonnés depuis plus de 24 h', discord: false });
  return items;
}

export async function applyCleanup(guild: Guild, items: CleanupItem[]): Promise<{ done: number; errors: string[] }> {
  let done = 0;
  const errors: string[] = [];
  for (const it of items) {
    try {
      if (it.id.startsWith('res:')) {
        const key = it.id.slice(4);
        const res = getResource(key);
        if (res && it.discord) {
          const target = res.kind === 'role' ? guild.roles.cache.get(res.discord_id) : guild.channels.cache.get(res.discord_id);
          await target?.delete(REASON + ' cleanup');
        }
        deleteResource(key);
      } else if (it.id.startsWith('ticket:')) {
        const id = Number(it.id.slice(7));
        const row = db().prepare('SELECT channel_id FROM tickets WHERE id = ?').get(id) as { channel_id: string | null } | undefined;
        if (row?.channel_id) await guild.channels.cache.get(row.channel_id)?.delete(REASON + ' cleanup');
        db().prepare('UPDATE tickets SET channel_id = NULL WHERE id = ?').run(id);
      } else if (it.id === 'drafts') {
        db().prepare('DELETE FROM application_drafts WHERE updated_at < ?').run(Date.now() - 864e5);
      }
      done++;
    } catch (e) {
      errors.push(`${it.label} : ${(e as Error).message}`);
    }
  }
  return { done, errors };
}
