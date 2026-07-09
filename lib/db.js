'use strict';

/**
 * Persistent storage for the site, backed by the built-in node:sqlite module.
 * The database file lives in ./data and therefore survives server restarts
 * and deploys (as long as the ./data directory is preserved).
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'ekt.db'));
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS about (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    eyebrow     TEXT NOT NULL DEFAULT '',
    title_html  TEXT NOT NULL DEFAULT '',
    body_html   TEXT NOT NULL DEFAULT '',
    image_path  TEXT,
    cta_label   TEXT NOT NULL DEFAULT '',
    cta_url     TEXT NOT NULL DEFAULT '',
    socials     TEXT NOT NULL DEFAULT '[]',
    updated_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS admins (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    email                TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash        TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    expires INTEGER NOT NULL,
    data    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tiers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    badge       TEXT NOT NULL DEFAULT '',
    price_text  TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    features    TEXT NOT NULL DEFAULT '[]',
    cta_label   TEXT NOT NULL DEFAULT 'Get Started',
    featured    INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS consults (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    phone      TEXT NOT NULL,
    message    TEXT NOT NULL DEFAULT '',
    is_read    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
`);

/**
 * Default About content — used both to seed an empty database and as the
 * frontend fallback. Mirrors the original hardcoded copy so nothing is lost.
 */
const DEFAULT_ABOUT = {
  eyebrow: 'The Trainer',
  title_html: 'Elijah<br><em>King</em><br>Turner',
  body_html:
    "<p>Elijah King Turner is a personal trainer and strength coach dedicated to building stronger, more capable athletes at every level. His approach is rooted in structured, progressive training and the kind of accountability that drives real, lasting results.</p>" +
    "<p>Whether you're picking up a barbell for the first time or chasing a new PR, Elijah builds programs around where you are — and structures every phase to get you where you want to be.</p>",
  image_path: '/hero-photo.png',
  cta_label: 'Work With Me',
  cta_url: '#contact',
  socials: [],
};

function rowToAbout(row) {
  if (!row) return null;
  let socials = [];
  try {
    socials = JSON.parse(row.socials || '[]');
  } catch {
    socials = [];
  }
  return {
    eyebrow: row.eyebrow,
    title_html: row.title_html,
    body_html: row.body_html,
    image_path: row.image_path || null,
    cta_label: row.cta_label,
    cta_url: row.cta_url,
    socials: Array.isArray(socials) ? socials : [],
    updated_at: row.updated_at || null,
  };
}

/** Returns the stored About content, or the defaults if nothing is saved yet. */
function getAbout() {
  const row = db.prepare('SELECT * FROM about WHERE id = 1').get();
  return row ? rowToAbout(row) : { ...DEFAULT_ABOUT, updated_at: null };
}

/** Insert-or-replace the single About row. */
function saveAbout(content) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO about (id, eyebrow, title_html, body_html, image_path, cta_label, cta_url, socials, updated_at)
    VALUES (1, @eyebrow, @title_html, @body_html, @image_path, @cta_label, @cta_url, @socials, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      eyebrow    = excluded.eyebrow,
      title_html = excluded.title_html,
      body_html  = excluded.body_html,
      image_path = excluded.image_path,
      cta_label  = excluded.cta_label,
      cta_url    = excluded.cta_url,
      socials    = excluded.socials,
      updated_at = excluded.updated_at
  `).run({
    eyebrow: content.eyebrow ?? '',
    title_html: content.title_html ?? '',
    body_html: content.body_html ?? '',
    image_path: content.image_path ?? null,
    cta_label: content.cta_label ?? '',
    cta_url: content.cta_url ?? '',
    socials: JSON.stringify(content.socials ?? []),
    updated_at: now,
  });
  return getAbout();
}

/** Returns the currently stored image path (or null), used for cleanup on replace. */
function getAboutImagePath() {
  const row = db.prepare('SELECT image_path FROM about WHERE id = 1').get();
  return row ? row.image_path : null;
}

/* ─── Pricing tiers ("Choose Your Level") ────────────────────────── */

/**
 * Default tiers — mirror the original hardcoded pricing cards, used to seed
 * an empty database so nothing is lost on first run.
 */
const DEFAULT_TIERS = [
  {
    name: 'Starter',
    badge: '',
    price_text: 'Contact for pricing',
    description: 'A foundation plan for beginners building consistent habits.',
    features: ['Personalized workout plan', 'Basic nutrition guidance', 'Progress tracking', 'Email support'],
    cta_label: 'Get Started',
    featured: false,
  },
  {
    name: 'Performance',
    badge: 'Most Popular',
    price_text: 'Contact for pricing',
    description: 'For athletes ready to commit to a structured program.',
    features: ['Custom periodized programming', 'Nutrition planning', 'Regular check-ins', 'Priority scheduling', 'Text support'],
    cta_label: 'Book Now',
    featured: true,
  },
  {
    name: 'Elite',
    badge: '',
    price_text: 'Contact for pricing',
    description: 'Full-spectrum coaching with daily accountability.',
    features: ['Advanced programming', 'Nutrition and recovery support', 'Daily accountability', 'Movement analysis'],
    cta_label: 'Go Elite',
    featured: false,
  },
];

function rowToTier(row) {
  let features = [];
  try {
    features = JSON.parse(row.features || '[]');
  } catch {
    features = [];
  }
  return {
    id: row.id,
    name: row.name,
    badge: row.badge,
    price_text: row.price_text,
    description: row.description,
    features: Array.isArray(features) ? features : [],
    cta_label: row.cta_label,
    featured: !!row.featured,
  };
}

function listTiers() {
  return db.prepare('SELECT * FROM tiers ORDER BY sort_order, id').all().map(rowToTier);
}

/** Replace the whole tier list atomically (the admin editor saves all at once). */
function replaceTiers(tiers) {
  const insert = db.prepare(`
    INSERT INTO tiers (name, badge, price_text, description, features, cta_label, featured, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM tiers');
    tiers.forEach((t, i) => {
      insert.run(t.name, t.badge, t.price_text, t.description, JSON.stringify(t.features), t.cta_label, t.featured ? 1 : 0, i);
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return listTiers();
}

// Seed on first run so the public page never renders an empty section.
if (db.prepare('SELECT COUNT(*) AS n FROM tiers').get().n === 0) {
  replaceTiers(DEFAULT_TIERS);
}

/* ─── Consult requests ───────────────────────────────────────────── */

function createConsult({ name, email, phone, message }) {
  db.prepare(`
    INSERT INTO consults (name, email, phone, message, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, email, phone, message || '', new Date().toISOString());
}

function listConsults() {
  return db.prepare('SELECT * FROM consults ORDER BY id DESC').all().map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    message: row.message,
    is_read: !!row.is_read,
    created_at: row.created_at,
  }));
}

function countUnreadConsults() {
  return db.prepare('SELECT COUNT(*) AS n FROM consults WHERE is_read = 0').get().n;
}

function setConsultRead(id, isRead) {
  return db.prepare('UPDATE consults SET is_read = ? WHERE id = ?').run(isRead ? 1 : 0, id).changes > 0;
}

function deleteConsult(id) {
  return db.prepare('DELETE FROM consults WHERE id = ?').run(id).changes > 0;
}

/* ─── Admin accounts ─────────────────────────────────────────────── */

// One-time migration from the old single-admin scheme (username-based
// `admin` table): drop the legacy table and invalidate every existing
// session so stale logins can't carry over into the new system.
(function migrateLegacyAdmin() {
  const legacy = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admin'")
    .get();
  if (legacy) {
    db.exec('DROP TABLE admin;');
    db.exec('DELETE FROM sessions;');
    console.log('[admin] migrated to email-based admin accounts; existing sessions were signed out.');
  }
})();

function rowToAdmin(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    password_hash: row.password_hash,
    must_change_password: !!row.must_change_password,
    created_at: row.created_at,
  };
}

function getAdminByEmail(email) {
  return rowToAdmin(db.prepare('SELECT * FROM admins WHERE email = ?').get(String(email || '')));
}

function getAdminById(id) {
  return rowToAdmin(db.prepare('SELECT * FROM admins WHERE id = ?').get(id));
}

function listAdmins() {
  return db.prepare('SELECT id, email, must_change_password, created_at FROM admins ORDER BY id').all()
    .map((r) => ({
      id: r.id,
      email: r.email,
      must_change_password: !!r.must_change_password,
      created_at: r.created_at,
    }));
}

function countAdmins() {
  return db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
}

function createAdmin(email, passwordHash, mustChange) {
  const info = db.prepare(`
    INSERT INTO admins (email, password_hash, must_change_password, created_at)
    VALUES (?, ?, ?, ?)
  `).run(email, passwordHash, mustChange ? 1 : 0, new Date().toISOString());
  return getAdminById(info.lastInsertRowid);
}

function updateAdminPassword(id, passwordHash, mustChange) {
  return db.prepare('UPDATE admins SET password_hash = ?, must_change_password = ? WHERE id = ?')
    .run(passwordHash, mustChange ? 1 : 0, id).changes > 0;
}

function deleteAdmin(id) {
  return db.prepare('DELETE FROM admins WHERE id = ?').run(id).changes > 0;
}

/** Remove every session belonging to the given admin id (used when an admin is deleted). */
function deleteSessionsForAdmin(adminId) {
  // Session JSON contains `"adminId":<n>` — match it defensively.
  db.prepare("DELETE FROM sessions WHERE data LIKE ?").run('%"adminId":' + Number(adminId) + '%');
}

module.exports = {
  db,
  DEFAULT_ABOUT,
  getAbout,
  saveAbout,
  getAboutImagePath,
  listTiers,
  replaceTiers,
  createConsult,
  listConsults,
  countUnreadConsults,
  setConsultRead,
  deleteConsult,
  getAdminByEmail,
  getAdminById,
  listAdmins,
  countAdmins,
  createAdmin,
  updateAdminPassword,
  deleteAdmin,
  deleteSessionsForAdmin,
};
