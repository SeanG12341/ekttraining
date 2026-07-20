# EKT Training

Landing site for EKT Training (Elijah King Turner) with an **admin-editable About
section**, a **monthly-membership booking calendar** backed by Stripe, and
client accounts with GDPR/CCPA data export.

The public site (`public/index.html`) is a single page featuring a scroll-driven
barbell-press animation. Members book sessions on `/booking`, where each time slot
can be held by only one athlete — the "no double-booking" guarantee is enforced by a
database UNIQUE index, not just application checks.

## Features

- **Booking calendar** (`/booking`) — monthly grid of live availability. Booking
  requires a signed-in client account with an **active Stripe monthly subscription**.
- **No double-booking** — a partial `UNIQUE` index on the active slot key makes it
  physically impossible for two bookings to hold the same time.
- **Stripe subscriptions** — hosted Checkout for sign-up and the Billing Portal for
  self-service cancellation. Card data never touches this server; a verified webhook
  keeps each account's subscription status in sync.
- **Client accounts** — separate from admins: register, sign in, book, cancel.
- **Data rights** — one-click **JSON export** of everything we hold about a client
  (data portability, GDPR Art. 20 / CCPA) and **account deletion** (erasure).
- **Legal pages** — `/privacy` and `/terms`, grounded in real regulations (links to
  ftc.gov, oag.ca.gov, ico.org.uk) and clearly marked as templates to have reviewed.
- **Security** — strict Content-Security-Policy + hardening headers, CSRF on every
  mutating route, bcrypt password hashing, rate-limited sign-in, signed httpOnly
  session cookies, and signature-verified Stripe webhooks.

## Requirements

- **Node.js 22.5+** (uses the built-in `node:sqlite` module — no native build tools needed)

## Setup

```bash
npm install
cp .env.example .env      # then edit .env (see below)
npm start
```

Then open:

- Public site: <http://localhost:4000>
- Admin dashboard: <http://localhost:4000/admin>

## Configuration (`.env`)

| Variable                 | Purpose                                                        | Default |
| ------------------------ | -------------------------------------------------------------- | ------- |
| `PORT`                   | Port the server listens on                                     | `3000`  |
| `ADMIN_INITIAL_PASSWORD` | Optional initial password for the seeded admin account         | —       |
| `SESSION_SECRET`         | Secret for signing session cookies (use a long one)            | —       |
| `SECURE_COOKIES`         | Set `true` when served over HTTPS                              | `false` |
| `STRIPE_SECRET_KEY`      | Stripe secret key — **keep server-side only, never commit**    | —       |
| `STRIPE_PRICE_ID`        | The recurring monthly Price members subscribe to (`price_…`)   | —       |
| `STRIPE_WEBHOOK_SECRET`  | Signing secret (`whsec_…`) for `/api/stripe/webhook`           | —       |
| `PUBLIC_BASE_URL`        | Public URL used for Stripe redirect links                      | `http://localhost:3000` |
| `BUSINESS_TZ`            | Timezone label shown on the booking calendar                   | `America/New_York` |
| `AVAILABILITY_JSON`      | Optional weekly availability override (see `.env.example`)     | built-in default |

> **Never commit Stripe keys.** They belong only in `.env` (git-ignored). If a key is
> ever exposed, roll it immediately in the Stripe dashboard → Developers → API keys.

## Billing setup (Stripe)

1. Create a **Product** in Stripe with a **monthly recurring Price**; copy its
   `price_…` id into `STRIPE_PRICE_ID`.
2. Put your `sk_…` secret key in `STRIPE_SECRET_KEY`.
3. Add a webhook endpoint pointing to `<PUBLIC_BASE_URL>/api/stripe/webhook`,
   subscribe to `checkout.session.completed` and the three
   `customer.subscription.*` events, and copy its signing secret into
   `STRIPE_WEBHOOK_SECRET`.

If Stripe isn't configured, the site still runs — the booking page simply shows a
"membership sign-up isn't switched on yet" message instead of the subscribe button.

## Admin accounts & sign-in

- On first start the server seeds one admin account (`elijah02.ek@gmail.com`).
  If `ADMIN_INITIAL_PASSWORD` is empty, a **random temporary password is printed
  once to the console** and must be changed on first sign-in.
- Sign in at `/admin` (there is also a subtle "Sign in" link at the very bottom
  of the public site). While signed in, the public site shows edit shortcuts and
  an admin bar with the consult-inbox unread count.
- **Settings** tab in the dashboard: change your password, and add or remove
  other admins by email. New admins receive a one-time temporary password
  (shown once) and must set their own on first sign-in.
- Login is rate-limited, passwords are bcrypt-hashed, sessions are httpOnly
  cookies, and all admin routes are CSRF-protected.

## How it works

- **`server.js`** — Express server: serves the site, a public `GET /api/about`
  endpoint, and authenticated admin endpoints.
- **`lib/db.js`** — SQLite storage (`data/ekt.db`) for the About content and admin
  account. Persists across restarts and deploys as long as the `data/` folder is kept.
- **`lib/images.js`** — validates uploads (type + 8 MB limit) and optimizes them with
  `sharp` (resized, converted to WebP) into `uploads/`.
- **`lib/sanitize.js`** — sanitizes admin-supplied HTML before it is stored.
- **`public/admin.html`** — the admin dashboard (login + editor with image preview,
  rich-text editing, social links, and a call-to-action).
- **`public/index.html`** — fetches `/api/about` on load and renders the About section.
  Ships with default fallback content so the section always shows something.

## What persists / what to back up

- `data/` — the SQLite database (About content, admin account, sessions)
- `uploads/` — optimized About images

Both are git-ignored. **Preserve these directories across deploys** to keep content.
