/**
 * Dates : saisie au format français (JJ/MM/AAAA [HH:MM]) ou ISO, interprétée dans le fuseau configuré.
 * Affichage côté Discord via les timestamps natifs <t:...> (localisés chez chaque membre).
 */

let timezone = process.env.TIMEZONE || 'Europe/Paris';
export function setTimezone(tz: string): void {
  timezone = tz;
}

/** Décalage (ms) du fuseau par rapport à UTC à un instant donné. */
function tzOffset(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Convertit une date « murale » du fuseau en timestamp UTC. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz = timezone): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ts = guess - tzOffset(guess, tz);
  // Second passage pour les changements d'heure.
  ts = guess - tzOffset(ts, tz);
  return ts;
}

/**
 * Accepte : 25/12/2026, 25/12/2026 18:30, 25-12-2026 18h30, 2026-12-25, 2026-12-25T18:30.
 * Retourne null si la saisie est invalide.
 */
export function parseDate(input: string, tz = timezone): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ t]+(\d{1,2})[:h](\d{2})?)?$/);
  let y: number, mo: number, d: number, h = 0, mi = 0;
  if (m) {
    d = +m[1];
    mo = +m[2];
    y = +m[3];
    if (m[4] !== undefined) {
      h = +m[4];
      mi = m[5] ? +m[5] : 0;
    }
  } else {
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{2}):(\d{2}))?$/);
    if (!m) return null;
    y = +m[1];
    mo = +m[2];
    d = +m[3];
    if (m[4] !== undefined) {
      h = +m[4];
      mi = +m[5];
    }
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1) return null; // 31/02 etc.
  return zonedToUtc(y, mo, d, h, mi, tz);
}

/** Durées : 30m, 2h, 1h30, 3j, 1d, 1w/1s (semaine). Retourne des millisecondes. */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  const re = /(\d+)(w|s|sem|d|j|h|m|min)?/g;
  let total = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  let lastUnit = '';
  while ((match = re.exec(s))) {
    if (match.index !== consumed) return null;
    consumed += match[0].length;
    const n = +match[1];
    let unit = match[2] ?? '';
    if (!unit) unit = lastUnit === 'h' ? 'm' : 'm'; // « 1h30 » → 30 minutes
    const mult: Record<string, number> = { w: 6048e5, s: 6048e5, sem: 6048e5, d: 864e5, j: 864e5, h: 36e5, m: 6e4, min: 6e4 };
    total += n * mult[unit];
    lastUnit = unit;
  }
  if (consumed !== s.length || total <= 0) return null;
  return total;
}

export function discordTs(ms: number, style: 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R' = 'f'): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

export function formatDate(ms: number | null | undefined, withTime = true, tz = timezone): string {
  if (!ms) return '—';
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: tz,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(new Date(ms));
}

/** Valeur pour <input type="datetime-local"> dans le fuseau configuré. */
export function toInputValue(ms: number | null | undefined, tz = timezone): string {
  if (!ms) return '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Saisie FR attendue dans les modales, pour pré-remplir. */
export function toFrInput(ms: number | null | undefined, withTime = true): string {
  if (!ms) return '';
  return formatDate(ms, withTime).replace(',', '');
}

export function formatDuration(ms: number): string {
  const min = Math.round(ms / 6e4);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  if (h < 24) return r ? `${h} h ${r}` : `${h} h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} j ${rh} h` : `${d} j`;
}
