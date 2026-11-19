/**
 * Signale qu'un membre a peut-être progressé sur un défi /rewards (invitation, candidature acceptée,
 * bug résolu…). Le module rewards s'y abonne : les autres modules n'ont pas besoin de le connaître.
 */
type Listener = (userId: string) => void;
const listeners: Listener[] = [];

export function onProgress(fn: Listener): void {
  listeners.push(fn);
}

export function progress(...userIds: (string | null | undefined)[]): void {
  for (const id of userIds) if (id) for (const fn of listeners) {
    try {
      fn(id);
    } catch {
      /* ne jamais casser l'appelant */
    }
  }
}
