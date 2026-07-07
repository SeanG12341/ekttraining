'use strict';

/**
 * A minimal express-session store backed by the node:sqlite `sessions` table.
 * Avoids native dependencies and keeps admin logins alive across restarts.
 */

module.exports = function createSqliteStore(session, db) {
  const Store = session.Store;

  class SqliteStore extends Store {
    constructor() {
      super();
      this.db = db;
      // Opportunistically clear expired sessions on startup and hourly.
      this._reap();
      this._timer = setInterval(() => this._reap(), 60 * 60 * 1000);
      if (this._timer.unref) this._timer.unref();
    }

    _reap() {
      try {
        this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
      } catch { /* ignore */ }
    }

    _expiry(sess) {
      const maxAge = sess && sess.cookie && sess.cookie.maxAge;
      return Date.now() + (typeof maxAge === 'number' ? maxAge : 24 * 60 * 60 * 1000);
    }

    get(sid, cb) {
      try {
        const row = this.db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
        if (!row) return cb(null, null);
        if (row.expires < Date.now()) {
          this.destroy(sid, () => {});
          return cb(null, null);
        }
        return cb(null, JSON.parse(row.data));
      } catch (err) {
        return cb(err);
      }
    }

    set(sid, sess, cb) {
      try {
        this.db.prepare(`
          INSERT INTO sessions (sid, expires, data) VALUES (?, ?, ?)
          ON CONFLICT(sid) DO UPDATE SET expires = excluded.expires, data = excluded.data
        `).run(sid, this._expiry(sess), JSON.stringify(sess));
        return cb ? cb(null) : undefined;
      } catch (err) {
        return cb ? cb(err) : undefined;
      }
    }

    touch(sid, sess, cb) {
      try {
        this.db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(this._expiry(sess), sid);
        return cb ? cb(null) : undefined;
      } catch (err) {
        return cb ? cb(err) : undefined;
      }
    }

    destroy(sid, cb) {
      try {
        this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return cb ? cb(null) : undefined;
      } catch (err) {
        return cb ? cb(err) : undefined;
      }
    }
  }

  return new SqliteStore();
};
