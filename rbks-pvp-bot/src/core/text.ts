export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

export function progressBar(percent: number, size = 10): string {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((p / 100) * size);
  return `${'▰'.repeat(filled)}${'▱'.repeat(size - filled)} ${p}%`;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Neutralise les mentions de masse dans un texte fourni par un membre. */
export function sanitizeMentions(s: string): string {
  return s.replace(/@(everyone|here)/gi, '@​$1');
}

/** Normalise un nom de salon/rôle pour la détection (sans emojis, accents ni ponctuation). */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
}

export function splitLines(s: string | null | undefined): string[] {
  return (s ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean);
}

export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n > 1 ? many : one}`;
}
