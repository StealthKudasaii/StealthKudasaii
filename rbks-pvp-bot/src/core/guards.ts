/** Cooldowns, verrous et anti-rebond partagés par les modules. */

const cooldowns = new Map<string, number>();

/** Retourne 0 si l'action est autorisée (et arme le cooldown), sinon le temps restant en ms. */
export function hitCooldown(key: string, ms: number): number {
  const t = Date.now();
  const until = cooldowns.get(key) ?? 0;
  if (until > t) return until - t;
  cooldowns.set(key, t + ms);
  if (cooldowns.size > 5000) for (const [k, v] of cooldowns) if (v < t) cooldowns.delete(k);
  return 0;
}

export function resetCooldown(key: string): void {
  cooldowns.delete(key);
}

/** Fenêtre glissante : max `limit` événements par `windowMs`. */
const windows = new Map<string, number[]>();
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const t = Date.now();
  const list = (windows.get(key) ?? []).filter((x) => x > t - windowMs);
  if (list.length >= limit) {
    windows.set(key, list);
    return false;
  }
  list.push(t);
  windows.set(key, list);
  return true;
}

/** Verrou asynchrone par clé : sérialise les traitements concurrents (ex. même candidature). */
const locks = new Map<string, Promise<unknown>>();
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((r) => (release = r));
  const chained = previous.then(() => current);
  locks.set(key, chained);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

/** Verrou non bloquant : false si déjà pris (pour refuser un double clic plutôt que l'attendre). */
const busy = new Set<string>();
export async function tryLock<T>(key: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  if (busy.has(key)) return { ok: false };
  busy.add(key);
  try {
    return { ok: true, value: await fn() };
  } finally {
    busy.delete(key);
  }
}

/** Regroupe les appels rapprochés (ex. plusieurs modifications de roadmap → une seule édition Discord). */
const timers = new Map<string, NodeJS.Timeout>();
export function debounce(key: string, ms: number, fn: () => Promise<unknown> | unknown, onError?: (e: unknown) => void): void {
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      Promise.resolve()
        .then(fn)
        .catch((e) => onError?.(e));
    }, ms),
  );
}

export function cancelAllDebounces(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
