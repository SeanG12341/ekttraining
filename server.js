'use strict';

require('dotenv').config();

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const store = require('./lib/db');
const createSqliteStore = require('./lib/session-store');
const { processAboutImage, deleteUpload, ImageError, MAX_BYTES, UPLOAD_DIR } = require('./lib/images');
const { cleanBodyHtml, cleanTitleHtml, cleanText } = require('./lib/sanitize');
const { sendContactEmail, isConfigured: mailerConfigured } = require('./lib/mailer');
const stripeSvc = require('./lib/stripe');
const booking = require('./lib/booking');

const PORT = process.env.PORT || 3000;
const SECURE_COOKIES = String(process.env.SECURE_COOKIES).toLowerCase() === 'true';

const app = express();
app.disable('x-powered-by');
if (SECURE_COOKIES) app.set('trust proxy', 1);

/* ─── Seed the first admin account on first run ─────────────────────
 * Seeds SEED_ADMIN_EMAIL with either ADMIN_INITIAL_PASSWORD from .env
 * (no forced change) or, if that is unset, a random temporary password
 * printed once to the console that must be changed on first login.
 * No password ever lives in the source code or the database as plain text. */
const SEED_ADMIN_EMAIL = 'elijah02.ek@gmail.com';

function generateTempPassword() {
  // 12 chars from an unambiguous alphabet (no 0/O, 1/l/I).
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (const byte of crypto.randomBytes(12)) out += alphabet[byte % alphabet.length];
  return out;
}

(function seedAdmin() {
  if (store.countAdmins() > 0) return;
  const envPassword = process.env.ADMIN_INITIAL_PASSWORD || '';
  const password = envPassword || generateTempPassword();
  store.createAdmin(SEED_ADMIN_EMAIL, bcrypt.hashSync(password, 12), !envPassword);
  if (envPassword) {
    console.log(`[admin] created admin account ${SEED_ADMIN_EMAIL} with the password from ADMIN_INITIAL_PASSWORD.`);
  } else {
    console.log('┌──────────────────────────────────────────────────────────────┐');
    console.log('│  First-run admin account created                             │');
    console.log(`│  Email:              ${SEED_ADMIN_EMAIL.padEnd(40)}│`);
    console.log(`│  Temporary password: ${password.padEnd(40)}│`);
    console.log('│  You will be asked to set a new password on first login.    │');
    console.log('│  This password is shown only once and is not stored in      │');
    console.log('│  plain text anywhere.                                        │');
    console.log('└──────────────────────────────────────────────────────────────┘');
  }
})();

/* ─── Security headers ────────────────────────────────────────────────
 * A strict, self-hosted Content-Security-Policy plus the usual hardening
 * headers. The CSP permits only Google Fonts and Stripe.js as external
 * origins; everything else is same-origin. Inline <style>/<script> in the
 * static pages are allowed via 'unsafe-inline' (there is no user-injected
 * markup on those pages — all dynamic HTML is sanitized server-side). */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  "font-src 'self' https://fonts.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "script-src 'self' 'unsafe-inline' https://js.stripe.com",
  "connect-src 'self' https://api.stripe.com",
  "frame-src https://js.stripe.com https://hooks.stripe.com https://checkout.stripe.com",
  "upgrade-insecure-requests",
].join('; ');

app.use((req, res, next) => {
  res.set('Content-Security-Policy', CSP);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(self "https://checkout.stripe.com")');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  if (SECURE_COOKIES) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  next();
});

/* ─── Stripe webhook ──────────────────────────────────────────────────
 * Mounted BEFORE the JSON body parser because signature verification needs
 * the exact raw request body. The signature (whsec_… secret) is the trust
 * boundary — unsigned or forged calls are rejected. */
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripeSvc.isConfigured() || !stripeSvc.hasWebhookSecret()) {
    return res.status(503).end();
  }
  let event;
  try {
    event = stripeSvc.constructEvent(req.body, req.get('stripe-signature'));
  } catch (err) {
    console.error('[stripe] webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    handleStripeEvent(event);
  } catch (err) {
    console.error('[stripe] webhook handler error:', err);
    // Still 200 so Stripe doesn't retry a poison event forever; we've logged it.
  }
  res.json({ received: true });
});

/** Reconcile a client's subscription snapshot from a Stripe event. */
function handleStripeEvent(event) {
  const obj = event.data && event.data.object;
  if (!obj) return;

  const applySub = (sub) => {
    const client = store.getClientByCustomerId(sub.customer);
    if (!client) return;
    const periodEnd = sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null;
    store.setClientSubscription(client.id, {
      subscriptionId: sub.id,
      status: sub.status, // active | trialing | past_due | canceled | unpaid | incomplete …
      currentPeriodEnd: periodEnd,
    });
  };

  switch (event.type) {
    case 'checkout.session.completed': {
      // Link the customer id to the client the moment checkout completes.
      const clientId = Number(obj.client_reference_id);
      if (clientId && obj.customer) store.setClientStripeCustomer(clientId, obj.customer);
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      applySub(obj);
      break;
    default:
      break;
  }
}

/* ─── Middleware ──────────────────────────────────────────────────── */
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

app.use(session({
  name: 'ekt.sid',
  secret: process.env.SESSION_SECRET || 'insecure-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: createSqliteStore(session, store.db),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: SECURE_COOKIES,
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
  },
}));

// Multer: in-memory so sharp can validate/optimize before anything is written.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

/* ─── CSRF protection (double-submit cookie) ──────────────────────────
 * Every visitor gets a random, JS-readable csrf cookie. Mutating requests
 * to auth/admin endpoints must echo it back in the X-CSRF-Token header;
 * cross-site pages can't read the cookie, so they can't forge the header. */
const CSRF_COOKIE = 'ekt.csrf';

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

app.use((req, res, next) => {
  if (!getCookie(req, CSRF_COOKIE)) {
    res.cookie(CSRF_COOKIE, crypto.randomBytes(24).toString('hex'), {
      httpOnly: false, // the frontend must read it to echo it back
      sameSite: 'lax',
      secure: SECURE_COOKIES,
      maxAge: 1000 * 60 * 60 * 24 * 7,
    });
  }
  next();
});

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function requireCsrf(req, res, next) {
  if (!MUTATING.has(req.method)) return next();
  const cookie = getCookie(req, CSRF_COOKIE);
  const header = req.get('x-csrf-token') || '';
  if (cookie && header && cookie === header) return next();
  return res.status(403).json({ error: 'Invalid or missing security token. Refresh the page and try again.' });
}

/** Require a valid admin session. Attaches req.admin, revoking sessions of deleted accounts. */
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.isAdmin || !req.session.adminId) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  const admin = store.getAdminById(req.session.adminId);
  if (!admin) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  req.admin = admin;
  return next();
}

/** Block everything except password change while a temporary password is in force. */
function requireFreshPassword(req, res, next) {
  if (req.admin && req.admin.must_change_password) {
    return res.status(403).json({
      error: 'You must set a new password before continuing.',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
  }
  return next();
}

// Auth + admin API: CSRF-check all mutating requests before anything else.
app.use('/api/admin', requireCsrf);
// Client-facing mutating APIs get the same double-submit CSRF protection.
// (The Stripe webhook above is exempt — it is verified by signature instead.)
app.use('/api/account', requireCsrf);
app.use('/api/bookings', requireCsrf);
app.use('/api/billing', requireCsrf);

/** Require a signed-in client account. Attaches req.client. */
function requireClient(req, res, next) {
  if (!req.session || !req.session.clientId) {
    return res.status(401).json({ error: 'Please sign in.' });
  }
  const client = store.getClientById(req.session.clientId);
  if (!client) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Please sign in.' });
  }
  req.client = client;
  return next();
}

/** A subscription counts as active if Stripe reports it active or trialing. */
function hasActiveSubscription(client) {
  return client && ['active', 'trialing'].includes(client.subscription_status);
}

/* ─── Public API ──────────────────────────────────────────────────── */
app.get('/api/about', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(store.getAbout());
});

/* ─── Contact form → email via Resend ─────────────────────────────── */
// Simple in-memory rate limit: max 5 submissions per IP per 10 minutes.
const contactHits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const hits = (contactHits.get(ip) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  contactHits.set(ip, hits);
  if (contactHits.size > 5000) contactHits.clear(); // guard against unbounded growth
  return hits.length > 5;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/contact', async (req, res) => {
  const body = req.body || {};

  // Honeypot: real users leave this hidden field empty. If filled, silently
  // accept without sending (don't tip off bots).
  if (cleanText(body.website)) return res.json({ ok: true });

  const name = cleanText(body.name).slice(0, 120);
  const email = cleanText(body.email).slice(0, 200);
  const goal = cleanText(body.goal).slice(0, 120);
  const message = cleanText(body.message).slice(0, 4000);

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Please fill in your name, email, and a message.' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (!mailerConfigured()) {
    return res.status(503).json({ error: 'Sorry — messaging is not available right now. Please try again later.' });
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Too many messages. Please try again in a little while.' });
  }

  const result = await sendContactEmail({ name, email, goal, message });
  if (!result.ok) {
    return res.status(502).json({ error: 'We couldn\'t send your message. Please try again shortly.' });
  }
  res.json({ ok: true });
});

/* ─── Consult requests (stored in the database, no email needed) ──── */
const PHONE_RE = /^[\d\s().+-]{7,30}$/;

app.post('/api/consult', (req, res) => {
  const body = req.body || {};

  // Honeypot: real users leave this hidden field empty.
  if (cleanText(body.website)) return res.json({ ok: true });

  const name = cleanText(body.name).slice(0, 120);
  const email = cleanText(body.email).slice(0, 200);
  const phone = cleanText(body.phone).slice(0, 30);
  const message = cleanText(body.message).slice(0, 2000);

  if (!name || !email || !phone) {
    return res.status(400).json({ error: 'Please fill in your name, email, and phone number.' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (!PHONE_RE.test(phone)) {
    return res.status(400).json({ error: 'Please enter a valid phone number.' });
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please try again in a little while.' });
  }

  store.createConsult({ name, email, phone, message });
  res.json({ ok: true });
});

/* ─── Auth API ────────────────────────────────────────────────────── */

// Brute-force protection: max 10 login attempts per IP per 15 minutes.
const loginHits = new Map();
function loginRateLimited(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const hits = (loginHits.get(ip) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  loginHits.set(ip, hits);
  if (loginHits.size > 5000) loginHits.clear();
  return hits.length > 10;
}

// Compared against when the email doesn't exist, so response time doesn't
// reveal whether an account is registered.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

const LOGIN_ERROR = 'Invalid email or password.';

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (loginRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many login attempts. Please try again in a few minutes.' });
  }

  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
    return res.status(401).json({ error: LOGIN_ERROR });
  }

  const admin = store.getAdminByEmail(email.trim());
  const ok = bcrypt.compareSync(password, admin ? admin.password_hash : DUMMY_HASH) && !!admin;
  if (!ok) return res.status(401).json({ error: LOGIN_ERROR });

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start session.' });
    req.session.isAdmin = true;
    req.session.adminId = admin.id;
    req.session.email = admin.email;
    res.json({ ok: true, email: admin.email, must_change_password: admin.must_change_password });
  });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('ekt.sid');
    res.json({ ok: true });
  });
});

app.get('/api/admin/session', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.session && req.session.isAdmin && req.session.adminId) {
    const admin = store.getAdminById(req.session.adminId);
    if (admin) {
      return res.json({
        authenticated: true,
        email: admin.email,
        must_change_password: admin.must_change_password,
        unread_consults: store.countUnreadConsults(),
      });
    }
  }
  res.json({ authenticated: false });
});

/* ─── Account management (self password + other admins) ──────────── */

const MIN_PASSWORD_LEN = 8;

app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (typeof current_password !== 'string' || typeof new_password !== 'string') {
    return res.status(400).json({ error: 'Please fill in both password fields.' });
  }
  if (!bcrypt.compareSync(current_password, req.admin.password_hash)) {
    return res.status(401).json({ error: 'Your current password is incorrect.' });
  }
  if (new_password.length < MIN_PASSWORD_LEN || new_password.length > 200) {
    return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LEN} characters.` });
  }
  if (new_password === current_password) {
    return res.status(400).json({ error: 'The new password must be different from the current one.' });
  }
  store.updateAdminPassword(req.admin.id, bcrypt.hashSync(new_password, 12), false);
  res.json({ ok: true });
});

app.get('/api/admin/admins', requireAdmin, requireFreshPassword, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ admins: store.listAdmins(), self_id: req.admin.id });
});

app.post('/api/admin/admins', requireAdmin, requireFreshPassword, (req, res) => {
  const email = cleanText((req.body || {}).email).slice(0, 200);
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (store.getAdminByEmail(email)) {
    return res.status(400).json({ error: 'An admin with that email already exists.' });
  }
  if (store.countAdmins() >= 20) {
    return res.status(400).json({ error: 'Admin limit reached.' });
  }
  // New admins get a one-time temporary password (shown once to the creator)
  // and must set their own password on first login.
  const tempPassword = generateTempPassword();
  const created = store.createAdmin(email, bcrypt.hashSync(tempPassword, 12), true);
  res.json({ ok: true, admin: { id: created.id, email: created.email }, temp_password: tempPassword });
});

app.delete('/api/admin/admins/:id', requireAdmin, requireFreshPassword, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid admin id.' });
  if (id === req.admin.id) {
    return res.status(400).json({ error: 'You cannot remove your own account.' });
  }
  if (!store.deleteAdmin(id)) {
    return res.status(404).json({ error: 'Admin not found.' });
  }
  store.deleteSessionsForAdmin(id); // sign the removed admin out everywhere
  res.json({ ok: true });
});

/* ─── Admin content API ───────────────────────────────────────────── */

const ALLOWED_SOCIALS = new Set(['instagram', 'x', 'youtube', 'facebook', 'tiktok', 'linkedin', 'website']);

/** Validate a CTA / social URL: relative anchors and paths, or safe schemes. */
function normalizeUrl(raw) {
  const url = cleanText(raw);
  if (!url) return '';
  if (url.startsWith('#') || url.startsWith('/')) return url;
  if (/^(https?:|mailto:|tel:)/i.test(url)) return url;
  // Bare domain like "instagram.com/foo" → assume https.
  if (/^[\w-]+(\.[\w-]+)+/.test(url)) return 'https://' + url;
  return '';
}

function parseSocials(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { arr = []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((s) => ({
      platform: cleanText(s && s.platform).toLowerCase(),
      url: normalizeUrl(s && s.url),
    }))
    .filter((s) => ALLOWED_SOCIALS.has(s.platform) && s.url)
    .slice(0, 8);
}

app.put('/api/admin/about', requireAdmin, requireFreshPassword, upload.single('image'), async (req, res) => {
  try {
    const body = req.body || {};
    const current = store.getAbout();

    const next = {
      eyebrow: cleanText(body.eyebrow).slice(0, 120),
      title_html: cleanTitleHtml(body.title_html).slice(0, 400),
      body_html: cleanBodyHtml(body.body_html).slice(0, 8000),
      cta_label: cleanText(body.cta_label).slice(0, 60),
      cta_url: normalizeUrl(body.cta_url),
      socials: parseSocials(body.socials),
      image_path: current.image_path,
    };

    // Handle image: new upload, explicit removal, or keep existing.
    let oldImageToDelete = null;
    if (req.file) {
      const result = await processAboutImage(req.file.buffer, req.file.mimetype);
      if (current.image_path && current.image_path.startsWith('/uploads/')) {
        oldImageToDelete = current.image_path;
      }
      next.image_path = result.path;
    } else if (String(body.remove_image) === 'true') {
      if (current.image_path && current.image_path.startsWith('/uploads/')) {
        oldImageToDelete = current.image_path;
      }
      next.image_path = null;
    }

    const saved = store.saveAbout(next);
    if (oldImageToDelete) deleteUpload(oldImageToDelete);

    res.json({ ok: true, about: saved });
  } catch (err) {
    if (err instanceof ImageError) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[about] save failed:', err);
    res.status(500).json({ error: 'Something went wrong while saving. Please try again.' });
  }
});

/* ─── Admin consult inbox API ─────────────────────────────────────── */

app.get('/api/admin/consults', requireAdmin, requireFreshPassword, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ consults: store.listConsults(), unread: store.countUnreadConsults() });
});

app.patch('/api/admin/consults/:id', requireAdmin, requireFreshPassword, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid request id.' });
  const isRead = !!(req.body || {}).is_read;
  if (!store.setConsultRead(id, isRead)) {
    return res.status(404).json({ error: 'Request not found.' });
  }
  res.json({ ok: true, unread: store.countUnreadConsults() });
});

app.delete('/api/admin/consults/:id', requireAdmin, requireFreshPassword, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid request id.' });
  if (!store.deleteConsult(id)) {
    return res.status(404).json({ error: 'Request not found.' });
  }
  res.json({ ok: true, unread: store.countUnreadConsults() });
});

/* ═══════════════════════════════════════════════════════════════════
   CLIENT ACCOUNTS  (people who subscribe and book sessions)
═══════════════════════════════════════════════════════════════════ */

// Reuse the same per-IP throttle used for admin logins.
const clientLoginHits = new Map();
function clientLoginRateLimited(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const hits = (clientLoginHits.get(ip) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  clientLoginHits.set(ip, hits);
  if (clientLoginHits.size > 5000) clientLoginHits.clear();
  return hits.length > 10;
}

function clientPublicView(client) {
  return {
    email: client.email,
    name: client.name,
    subscription_status: client.subscription_status,
    subscription_active: hasActiveSubscription(client),
    current_period_end: client.current_period_end,
  };
}

app.post('/api/account/register', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (clientLoginRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Please try again in a few minutes.' });
  }
  const body = req.body || {};
  const email = cleanText(body.email).slice(0, 200);
  const name = cleanText(body.name).slice(0, 120);
  const password = typeof body.password === 'string' ? body.password : '';

  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (password.length < MIN_PASSWORD_LEN || password.length > 200) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters.` });
  }
  if (store.getClientByEmail(email)) {
    return res.status(400).json({ error: 'An account with that email already exists. Please sign in.' });
  }

  const client = store.createClient({ email, name, passwordHash: bcrypt.hashSync(password, 12) });
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start session.' });
    req.session.clientId = client.id;
    res.json({ ok: true, account: clientPublicView(client) });
  });
});

app.post('/api/account/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (clientLoginRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many login attempts. Please try again in a few minutes.' });
  }
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
    return res.status(401).json({ error: LOGIN_ERROR });
  }
  const client = store.getClientByEmail(email.trim());
  const ok = bcrypt.compareSync(password, client ? client.password_hash : DUMMY_HASH) && !!client;
  if (!ok) return res.status(401).json({ error: LOGIN_ERROR });

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start session.' });
    req.session.clientId = client.id;
    res.json({ ok: true, account: clientPublicView(client) });
  });
});

app.post('/api/account/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('ekt.sid');
    res.json({ ok: true });
  });
});

app.get('/api/account/session', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.session && req.session.clientId) {
    const client = store.getClientById(req.session.clientId);
    if (client) {
      return res.json({
        authenticated: true,
        account: clientPublicView(client),
        billing_configured: stripeSvc.isConfigured(),
      });
    }
  }
  res.json({ authenticated: false, billing_configured: stripeSvc.isConfigured() });
});

app.post('/api/account/change-password', requireClient, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (typeof current_password !== 'string' || typeof new_password !== 'string') {
    return res.status(400).json({ error: 'Please fill in both password fields.' });
  }
  if (!bcrypt.compareSync(current_password, req.client.password_hash)) {
    return res.status(401).json({ error: 'Your current password is incorrect.' });
  }
  if (new_password.length < MIN_PASSWORD_LEN || new_password.length > 200) {
    return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LEN} characters.` });
  }
  store.updateClientPassword(req.client.id, bcrypt.hashSync(new_password, 12));
  res.json({ ok: true });
});

/* ─── GDPR / CCPA: data access (portability) & erasure ─────────────── */

// Right to data portability — download everything we hold about you as JSON.
app.get('/api/account/export', requireClient, (req, res) => {
  const data = store.exportClientData(req.client.id);
  const payload = {
    exported_at: new Date().toISOString(),
    notice: 'This file contains the personal data EKT Training holds about your account, '
      + 'provided under your right to data portability (GDPR Art. 20 / CCPA). '
      + 'Payment card details are held only by Stripe and are never stored on this site.',
    ...data,
  };
  res.set('Content-Type', 'application/json');
  res.set('Content-Disposition', `attachment; filename="ekt-training-my-data-${req.client.id}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});

// Right to erasure — delete the account and all bookings. Stripe subscriptions
// must be cancelled separately in the billing portal (we surface that in the UI).
app.post('/api/account/delete', requireClient, (req, res) => {
  const id = req.client.id;
  store.deleteClient(id);
  store.deleteSessionsForClient(id);
  req.session.destroy(() => {
    res.clearCookie('ekt.sid');
    res.json({ ok: true });
  });
});

/* ─── Billing (Stripe monthly subscription) ───────────────────────── */

app.post('/api/billing/checkout', requireClient, async (req, res) => {
  if (!stripeSvc.isConfigured()) {
    return res.status(503).json({ error: 'Online payments are not set up yet. Please contact us to subscribe.' });
  }
  try {
    const customerId = await stripeSvc.ensureCustomer({
      email: req.client.email,
      name: req.client.name,
      existingId: req.client.stripe_customer_id,
    });
    if (customerId !== req.client.stripe_customer_id) {
      store.setClientStripeCustomer(req.client.id, customerId);
    }
    const url = await stripeSvc.createCheckoutSession({ customerId, clientId: req.client.id });
    res.json({ ok: true, url });
  } catch (err) {
    console.error('[billing] checkout failed:', err.message);
    res.status(502).json({ error: 'Could not start checkout. Please try again.' });
  }
});

app.post('/api/billing/portal', requireClient, async (req, res) => {
  if (!stripeSvc.isConfigured() || !req.client.stripe_customer_id) {
    return res.status(400).json({ error: 'No active billing profile found.' });
  }
  try {
    const url = await stripeSvc.createPortalSession({ customerId: req.client.stripe_customer_id });
    res.json({ ok: true, url });
  } catch (err) {
    console.error('[billing] portal failed:', err.message);
    res.status(502).json({ error: 'Could not open the billing portal. Please try again.' });
  }
});

/* ─── Calendar & bookings ─────────────────────────────────────────── */

// Public: the month grid with availability + which slots are already taken.
app.get('/api/slots', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const now = new Date();
  let year = Number(req.query.year);
  let month = Number(req.query.month); // 1-12
  if (!Number.isInteger(year) || year < 2020 || year > 2100) year = now.getFullYear();
  if (!Number.isInteger(month) || month < 1 || month > 12) month = now.getMonth() + 1;

  const fromKey = `${year}-${String(month).padStart(2, '0')}-00`;
  const toKey = `${year}-${String(month).padStart(2, '0')}-99`;
  const bookedKeys = new Set(store.bookedSlotKeysInRange(fromKey, toKey));
  const days = booking.buildMonth(year, month, bookedKeys, now);
  res.json({ year, month, timezone: booking.BUSINESS_TZ, session_minutes: booking.SESSION_MINUTES, days });
});

app.get('/api/bookings', requireClient, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ bookings: store.listBookingsForClient(req.client.id) });
});

app.post('/api/bookings', requireClient, (req, res) => {
  if (!hasActiveSubscription(req.client)) {
    return res.status(402).json({
      error: 'An active monthly subscription is required to book sessions.',
      code: 'SUBSCRIPTION_REQUIRED',
    });
  }
  const slot = cleanText((req.body || {}).slot);
  if (!booking.isValidSlotKey(slot)) {
    return res.status(400).json({ error: 'That time slot is not available.' });
  }
  const start = booking.slotKeyToDate(slot);
  if (!start || start.getTime() < Date.now()) {
    return res.status(400).json({ error: 'That time slot is in the past.' });
  }
  const result = store.createBooking(req.client.id, slot);
  if (!result.ok) {
    return res.status(409).json({ error: 'Sorry — that time was just booked by someone else. Please pick another slot.' });
  }
  res.json({ ok: true, booking: result.booking });
});

app.delete('/api/bookings/:id', requireClient, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid booking id.' });
  if (!store.cancelBooking(id, req.client.id)) {
    return res.status(404).json({ error: 'Booking not found.' });
  }
  res.json({ ok: true });
});

// Admin: full booking list.
app.get('/api/admin/bookings', requireAdmin, requireFreshPassword, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ bookings: store.listAllBookings() });
});

/* ─── Static assets & pages ───────────────────────────────────────── */
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '30d',
  setHeaders: (res) => res.set('Cache-Control', 'public, max-age=2592000'),
}));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

/* ─── Multer / error handling ─────────────────────────────────────── */
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'Image is too large. Maximum size is 8 MB.'
      : 'Upload failed. Please try a different image.';
    return res.status(400).json({ error: msg });
  }
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, () => {
  console.log(`EKT Training running at http://localhost:${PORT}`);
  console.log(`Admin dashboard at   http://localhost:${PORT}/admin`);
});
