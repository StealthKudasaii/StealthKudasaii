import session from 'express-session';
import { db } from '../db';

/** Stockage des sessions du panel dans SQLite (survit aux redémarrages). */
export class SqliteSessionStore extends session.Store {
  constructor(private ttlMs = 7 * 864e5) {
    super();
  }

  override get(sid: string, cb: (err: unknown, s?: session.SessionData | null) => void): void {
    try {
      const row = db().prepare('SELECT sess, expires FROM web_sessions WHERE sid = ?').get(sid) as { sess: string; expires: number } | undefined;
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (e) {
      cb(e);
    }
  }

  override set(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void): void {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + this.ttlMs;
      db()
        .prepare('INSERT INTO web_sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires')
        .run(sid, JSON.stringify(sess), expires);
      cb?.();
    } catch (e) {
      cb?.(e);
    }
  }

  override destroy(sid: string, cb?: (err?: unknown) => void): void {
    try {
      db().prepare('DELETE FROM web_sessions WHERE sid = ?').run(sid);
      cb?.();
    } catch (e) {
      cb?.(e);
    }
  }

  override touch(sid: string, sess: session.SessionData, cb?: () => void): void {
    this.set(sid, sess, () => cb?.());
  }
}
