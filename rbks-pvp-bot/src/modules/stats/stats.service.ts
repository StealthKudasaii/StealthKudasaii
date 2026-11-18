import { db } from '../../db';
import { tryGetGuild } from '../../bot/client';
import { roleId } from '../../core/resources';

const count = (sql: string, ...params: unknown[]) => (db().prepare(sql).get(...(params as never[])) as { n: number }).n;

export interface ServerStats {
  members: number | null;
  testers: number | null;
  applications: number;
  applicationsAccepted: number;
  applicationsPending: number;
  ticketsOpen: number;
  ticketsTotal: number;
  bugsTotal: number;
  bugsOpen: number;
  suggestions: number;
  suggestionsPending: number;
  testSessions: number;
  tasksOpen: number;
  tasksDone: number;
  polls: number;
}

/** Statistiques partagées entre /stats et le tableau de bord du panel. */
export function serverStats(): ServerStats {
  const guild = tryGetGuild();
  const tester = roleId('tester');
  return {
    members: guild?.memberCount ?? null,
    testers: guild && tester ? (guild.roles.cache.get(tester)?.members.size ?? null) : null,
    applications: count('SELECT COUNT(*) n FROM applications'),
    applicationsAccepted: count("SELECT COUNT(*) n FROM applications WHERE status = 'accepted'"),
    applicationsPending: count("SELECT COUNT(*) n FROM applications WHERE status IN ('pending','on_hold')"),
    ticketsOpen: count("SELECT COUNT(*) n FROM tickets WHERE status != 'closed'"),
    ticketsTotal: count('SELECT COUNT(*) n FROM tickets'),
    bugsTotal: count('SELECT COUNT(*) n FROM bugs'),
    bugsOpen: count("SELECT COUNT(*) n FROM bugs WHERE status IN ('new','acknowledged','in_progress')"),
    suggestions: count('SELECT COUNT(*) n FROM suggestions'),
    suggestionsPending: count("SELECT COUNT(*) n FROM suggestions WHERE status = 'pending'"),
    testSessions: count("SELECT COUNT(*) n FROM test_sessions WHERE status != 'cancelled'"),
    tasksOpen: count("SELECT COUNT(*) n FROM tasks WHERE status != 'done'"),
    tasksDone: count("SELECT COUNT(*) n FROM tasks WHERE status = 'done'"),
    polls: count('SELECT COUNT(*) n FROM polls'),
  };
}
