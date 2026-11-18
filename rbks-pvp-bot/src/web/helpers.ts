import { ChannelType } from 'discord.js';
import type { Request, Response } from 'express';
import { tryGetGuild } from '../bot/client';
import { parseDate } from '../core/time';
import { flash } from './middleware';

export function guildRoles(): { id: string; name: string; color: string; position: number; managed: boolean }[] {
  const g = tryGetGuild();
  if (!g) return [];
  return [...g.roles.cache.values()]
    .filter((r) => r.id !== g.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name, color: r.hexColor === '#000000' ? '#99aab5' : r.hexColor, position: r.position, managed: r.managed }));
}

export function guildTextChannels(): { id: string; name: string; parent: string | null }[] {
  const g = tryGetGuild();
  if (!g) return [];
  return [...g.channels.cache.values()]
    .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
    .sort((a, b) => ('rawPosition' in a && 'rawPosition' in b ? (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) || a.rawPosition - b.rawPosition : 0))
    .map((c) => ({ id: c.id, name: c.name, parent: c.parent?.name ?? null }));
}

export function memberName(id: string | null | undefined): string {
  if (!id) return '—';
  const m = tryGetGuild()?.members.cache.get(id);
  return m ? m.displayName : id;
}

/** Lecture tolérante des champs de formulaire HTML. */
export const field = {
  str(body: Record<string, unknown>, key: string, max = 4000): string {
    const v = body[key];
    return (typeof v === 'string' ? v : '').trim().slice(0, max);
  },
  optStr(body: Record<string, unknown>, key: string, max = 4000): string | null {
    return field.str(body, key, max) || null;
  },
  bool(body: Record<string, unknown>, key: string): boolean {
    const v = body[key];
    return v === 'on' || v === '1' || v === 'true' || (Array.isArray(v) && v.includes('1'));
  },
  int(body: Record<string, unknown>, key: string, min: number, max: number): number | null {
    const raw = field.str(body, key, 20);
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new FormError(`Valeur invalide pour « ${key} » (entre ${min} et ${max}).`);
    return n;
  },
  date(body: Record<string, unknown>, key: string): number | null {
    const raw = field.str(body, key, 30);
    if (!raw) return null;
    const v = parseDate(raw);
    if (v === null) throw new FormError(`Date invalide pour « ${key} ».`);
    return v;
  },
  ids(body: Record<string, unknown>, key: string): string[] {
    const v = body[key];
    const list = Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : [];
    return [...new Set(list.filter((x): x is string => typeof x === 'string' && /^\d{17,20}$/.test(x)))];
  },
  id(body: Record<string, unknown>, key: string): string | null {
    const v = field.str(body, key, 25);
    if (!v) return null;
    if (!/^\d{17,20}$/.test(v)) throw new FormError(`Identifiant invalide pour « ${key} ».`);
    return v;
  },
  oneOf<T extends string>(body: Record<string, unknown>, key: string, allowed: readonly T[], def?: T): T {
    const v = field.str(body, key, 50) as T;
    if (allowed.includes(v)) return v;
    if (def !== undefined) return def;
    throw new FormError(`Valeur non autorisée pour « ${key} ».`);
  },
};

export class FormError extends Error {}

/** Exécute une action de formulaire : message de succès, ou erreur lisible, puis retour à la page. */
export async function action(req: Request, res: Response, back: string | (() => string), fn: () => Promise<string | void> | string | void): Promise<void> {
  try {
    const msg = await fn();
    if (msg) flash(req, 'success', msg);
  } catch (e) {
    flash(req, 'error', e instanceof FormError ? e.message : `Erreur : ${(e as Error).message}`);
  }
  res.redirect(typeof back === 'function' ? back() : back);
}

export function page(req: Request, size = 25): { limit: number; offset: number; page: number } {
  const p = Math.max(1, Number(req.query.page) || 1);
  return { limit: size, offset: (p - 1) * size, page: p };
}
