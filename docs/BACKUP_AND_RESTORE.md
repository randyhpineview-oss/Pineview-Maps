# Backup & Restore — Pineview Maps

Quick reference for how Pineview Maps' data is protected and how to
recover from various disasters.

---

## TL;DR

✅ **The database is automatically backed up by Supabase Pro** —
daily snapshots with 7-day retention, plus point-in-time recovery to
any second in the last 7 days. No manual setup, no maintenance.
Verify anytime at:
**Supabase Dashboard → your project → Database → Backups**.

⚠️ **The remaining gap is your secrets and API keys.** If you lose
access to your Render or Vercel account, you cannot rebuild the app
even with the database intact. **Do [Step 1](#step-1--back-up-your-secrets-the-only-real-gap) once, today.** It takes ~10 minutes.

---

## What is at risk

| Asset                                          | Where it lives        | How it's protected                                                |
| ---------------------------------------------- | --------------------- | ----------------------------------------------------------------- |
| App source code                                | GitHub repo           | GitHub redundancy + your local clones                             |
| **Database** (pins, sites, users, lease sheets, T&M tickets) | Supabase Postgres | Supabase Pro daily backups + PITR + restore-to-new-project |
| PDFs + photos                                  | Dropbox               | Dropbox 30-day version history                                    |
| **Backend env vars**                           | Render dashboard      | **Not backed up — see Step 1**                                    |
| **Frontend env vars**                          | Vercel dashboard      | **Not backed up — see Step 1**                                    |
| **Supabase / Dropbox / SMTP credentials**      | Various dashboards    | **Not backed up — see Step 1**                                    |

---

## Step 1 — Back up your secrets (the only real gap)

The database is safe with Supabase Pro. The code is safe on GitHub.
The Dropbox files are safe on Dropbox. **The one thing that is not
backed up anywhere is the collection of passwords and API keys that
glue them all together.** If you lose those, you cannot rebuild the
app even with everything else intact.

### What to save

Save all of the following into a **password manager** (1Password,
Bitwarden, Apple Passwords, etc.). **Not** a plain text file or a
sticky note.

#### Account logins (with 2FA recovery codes)

- Supabase
- Render
- Vercel
- Dropbox
- GitHub
- Google (for the Maps API)
- Your domain registrar (if you have a custom domain)

#### Supabase

- Database password (Project Settings → Database → Database password)
- The full session-pooler connection string

#### From Render (backend service → Environment tab)

Copy each of these values:

```
DATABASE_URL
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
ALLOWED_ORIGINS
SMTP_HOST
SMTP_PORT
SMTP_USER
SMTP_PASSWORD
SMTP_FROM_NAME
SMTP_FROM_EMAIL
FRONTEND_URL
DROPBOX_REFRESH_TOKEN
DROPBOX_APP_KEY
DROPBOX_APP_SECRET
```

#### From Vercel (project → Settings → Environment Variables)

```
VITE_API_BASE_URL
VITE_GOOGLE_MAPS_API_KEY
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

#### Local files

Save copies of these as secure notes in your password manager:

- `backend/.env` (if you have one)
- `frontend/.env` (if you have one)
- `frontend/.env.production`

### How to do it

1. Open your password manager and create a new "Secure Note" called
   **Pineview Maps — Production Secrets**.
2. For each Render env var, click the eye icon to reveal it, copy
   the value, and paste it in the note as `KEY=value`.
3. Repeat for Vercel.
4. Add the account login section.
5. Save.

**Re-do this any time you rotate a password or add a new env var.**

---

## Restore scenarios

### Scenario A — Roll back the database to an earlier point

Use this if data was accidentally deleted, corrupted, or a bad import
broke things.

1. **Supabase Dashboard → Database → Backups**.
2. Pick the right tab:
   - **Scheduled backups** — restore to the start of any of the last
     ~7 days (what you saw in your screenshot).
   - **Point in time** — restore to any specific *second* in the last
     7 days. Use this if you know roughly when the bad change
     happened.
3. Click **Restore** next to your chosen point.
4. ⚠️ **Restoring overwrites the current database.** If the current
   state contains anything you might still want, click **Create
   backup now** first (top of the same page) so you can roll forward
   again if needed.

### Scenario B — Current project is broken, restore into a fresh one

Use this if the project itself is corrupted, you got compromised, or
support tells you to start over.

1. **Supabase Dashboard → Database → Backups → "Restore to new
   project"** tab.
2. Pick the backup, name the new project, click **Restore**.
3. Wait for it to provision (~2 min).
4. Open the new project, get its new connection details (Connect
   button at top → copy URL + keys).
5. Update env vars in **Render** (backend) and **Vercel** (frontend)
   to point at the new project. Specifically:
   - Render: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
     `SUPABASE_SERVICE_ROLE_KEY`.
   - Vercel: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
6. Trigger a redeploy on Render and Vercel.
7. Smoke test: log in, confirm pins render, generate a test PDF.

### Scenario C — Total catastrophic loss (everything gone)

Lost the Supabase account, Render service, Vercel project, AND your
laptop. You have your password manager and your GitHub login.

With the current setup (Supabase Pro only, no off-platform backup),
**the most recent database state is unrecoverable** if you've also
lost Supabase account access. This is the trade-off you accepted by
not setting up the off-platform GitHub Action backup.

What you *can* recover:

- **Source code** — clone from GitHub, deploy to a new Render +
  Vercel.
- **File attachments (PDFs, photos)** — still on Dropbox (separate
  account).
- **A fresh empty database** — create new Supabase project, run the
  schema SQL files from `database/` and `backend/*_migration.sql`.
- **Old data manually re-imported** — if you have a recent KML
  export of pins, you can import it via the admin panel.

If this risk concerns you, you can re-add the off-platform backup
workflow at any time. It was previously committed at `9ea5dbb` —
ask Cascade to "restore the GitHub Action backup workflow" and it
will recreate it.

---

## Maintenance checklist

- **Today:** Step 1 — secrets to password manager. (Most important.)
- **Quarterly:** Verify Supabase backups are still listed by visiting
  **Database → Backups**. Should show ~7 daily entries.
- **Before any risky operation** (large import, schema migration,
  bulk delete): click **"Create backup now"** in Supabase to make a
  fresh restore point on top of the daily ones.
- **After rotating any password or API key:** update your password
  manager the same day.
- **Annually:** dry-run a restore. Use Scenario B's
  *"Restore to new project"* feature into a throwaway free project,
  confirm pins render, then delete the throwaway. A backup that has
  never been tested is not really a backup.
