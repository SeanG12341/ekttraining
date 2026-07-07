# EKT Training

Landing site for EKT Training (Elijah King Turner) with an **admin-editable About section**.

The public site is a single page (`public/index.html`). The About section is rendered
from content stored in a database and managed through an admin dashboard — no code
edits required to change it.

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
