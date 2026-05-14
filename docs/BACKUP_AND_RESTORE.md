# Backup & Restore — Pineview Maps

This document is the **single source of truth** for protecting Pineview Maps
data and for rebuilding the app from scratch if everything is lost.

If you are reading this because something has gone wrong, jump to
[Disaster recovery — rebuild from zero](#disaster-recovery--rebuild-from-zero).

---

## What is at risk

| Asset                     | Where it lives                  | Replaceable?           |
| ------------------------- | ------------------------------- | ---------------------- |
| App source code           | GitHub: `randyhpineview-oss/Pineview-Maps` | Yes (already on GitHub) |
| **Database** (pins, sites, users, lease sheets, T&M tickets) | Supabase Postgres | **No — irreplaceable** |
| PDFs + photos             | Dropbox (`/Pineview Maps`, `/<YYYY> Spray Records`) | Yes — Dropbox versioning |
| Backend env vars          | Render dashboard                | No — must be re-entered |
| Frontend env vars         | Vercel dashboard                | No — must be re-entered |
| Google Maps API key       | Google Cloud Console            | Re-generatable          |
| Dropbox refresh token     | Dropbox App Console             | Re-generatable          |

**The database is the only piece that, if lost, cannot be reconstructed.**
Everything below is about protecting it.

---

## Automated daily backups (already set up)

The workflow at `.github/workflows/db-backup.yml` runs every day at
**09:00 UTC** (≈ 02:00 Pacific) and produces two copies of the backup:

1. **GitHub Actions artifact** — 90-day retention, downloadable from
   the Actions tab.
2. **Permanent commit on the `backups` branch** of this repo — never
   expires, browsable in the GitHub UI.

You can also run it manually anytime:
**GitHub → Actions → "Database Backup" → "Run workflow"**.

### One-time setup

1. **Get the Supabase session-pooler connection string.**
   - Supabase Dashboard → your project → **Connect** (top of page).
   - Under **Connection string**, pick the **Session pooler** tab
     (port `5432`). **Do not** use the Transaction pooler (port `6543`)
     — `pg_dump` does not work there.
   - The format is:
     ```
     postgres://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
     ```
   - Replace `<password>` with the real DB password (find/reset under
     **Project Settings → Database → Database password**).

2. **Add it as a repo secret.**
   - GitHub → repo → **Settings → Secrets and variables → Actions →
     New repository secret**.
   - Name: `SUPABASE_DB_URL`
   - Value: the full connection string from step 1.

3. **Test the workflow.**
   - GitHub → **Actions → "Database Backup" → Run workflow → Run workflow**.
   - It should finish in under 2 minutes. Confirm:
     - A green checkmark on the run.
     - A `pineview-db-backup-…` artifact at the bottom of the run page.
     - A new commit on the `backups` branch under `<YYYY>/<MM>/`.

### Where the backup lives

- **Latest (last 90 days), fast download:**
  GitHub → Actions → click any "Database Backup" run → scroll to
  *Artifacts*.
- **Long-term archive, permanent:**
  GitHub → **branch dropdown → `backups` → `<YYYY>/<MM>/`**.
  Or clone it locally:
  ```powershell
  git clone --branch backups --single-branch `
    https://github.com/randyhpineview-oss/Pineview-Maps.git pineview-backups
  ```

---

## Manual one-off backup

Useful before any risky operation (large import, schema migration, etc.).

### Option A — Trigger the workflow manually

GitHub → Actions → "Database Backup" → **Run workflow**. Done.

### Option B — From your Windows machine

Requires PostgreSQL client tools installed locally (`pg_dump.exe` on PATH).
Easiest install: <https://www.postgresql.org/download/windows/>

```powershell
$env:PGPASSWORD = "<your-db-password>"
$stamp = Get-Date -Format "yyyyMMddTHHmmssZ" -AsUTC
pg_dump `
  "postgres://postgres.<project-ref>@aws-0-<region>.pooler.supabase.com:5432/postgres" `
  --no-owner --no-privileges --quote-all-identifiers --format=plain `
  | gzip > "pineview-$stamp.sql.gz"
```

### Option C — From the Supabase Dashboard

**Database → Backups → Download backup**. Free tier retains daily
backups for 7 days; Pro retains longer + supports point-in-time
recovery.

---

## Restore a backup

### Into the existing Supabase project (revert recent changes)

> ⚠️ **This will overwrite the current database.** Take a fresh
> backup first (run the workflow manually).

1. Download the desired `pineview-<stamp>.sql.gz` from either the
   Actions artifact or the `backups` branch.
2. From a machine with `psql` installed:
   ```powershell
   $env:PGPASSWORD = "<your-db-password>"
   gunzip -c pineview-<stamp>.sql.gz | psql `
     "postgres://postgres.<project-ref>@aws-0-<region>.pooler.supabase.com:5432/postgres"
   ```
3. Watch for errors. The dump uses `--no-owner --no-privileges`, so it
   should replay cleanly into a Supabase project regardless of role
   ownership.

### Into a brand-new Supabase project (full recovery)

See [Disaster recovery — rebuild from zero](#disaster-recovery--rebuild-from-zero).

---

## Other things worth backing up

The workflow only covers the database. For full peace of mind also save:

### Secrets / environment variables

Export from each platform once, then store in a password manager
(1Password / Bitwarden) or an encrypted file. Without these, the app
cannot be rebuilt.

- **Render** (backend) → Service → **Environment** tab. Copy each var.
- **Vercel** (frontend) → Project → **Settings → Environment Variables**.
- **Local** → contents of `backend/.env` and `frontend/.env`.

Minimum set to capture:

```
# Backend (Render)
DATABASE_URL
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
ALLOWED_ORIGINS
SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / SMTP_FROM_NAME / SMTP_FROM_EMAIL
FRONTEND_URL
DROPBOX_REFRESH_TOKEN
DROPBOX_APP_KEY
DROPBOX_APP_SECRET

# Frontend (Vercel)
VITE_API_BASE_URL
VITE_GOOGLE_MAPS_API_KEY
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

### Schema migration SQL files

Already in git, but worth knowing where they are — needed when
rebuilding a fresh Supabase project before restoring data:

- `database/enable_realtime.sql`
- `database/herbicide_lease_sheet_setup.sql`
- `backend/*.sql` (all `*_migration.sql` files — apply in chronological
  order based on filename)

### Dropbox files

Dropbox already keeps 30 days of version history. For longer:
- Enable **Dropbox Rewind** (paid).
- Or mirror with `rclone` to another cloud:
  ```
  rclone sync dropbox:/ b2:pineview-archive/ --fast-list
  ```

### Source code redundancy

Already on GitHub. Optional extras:
- Add a second git remote (private GitLab / Bitbucket) and push there
  occasionally.
- Periodic `git clone --mirror` to an external drive.

---

## Disaster recovery — rebuild from zero

You are here because **everything is gone**: Supabase project deleted,
Render service deleted, Vercel project deleted, laptop lost. You have:

- The GitHub repo (and the `backups` branch within it).
- The secrets export from your password manager.
- Your Google / Dropbox / Supabase / Render / Vercel account logins.

Time to back online: **~30 minutes**.

### Step 1 — Clone the code

```powershell
git clone https://github.com/randyhpineview-oss/Pineview-Maps.git
git clone --branch backups --single-branch `
  https://github.com/randyhpineview-oss/Pineview-Maps.git Pineview-Maps-backups
```

### Step 2 — Create a fresh Supabase project

1. <https://supabase.com/dashboard> → **New project**.
2. Pick a strong DB password. **Save it in your password manager.**
3. Wait for provisioning (~2 min).

### Step 3 — Apply the schema

The pg_dump backup includes schema **and** data, so for the simple
case you can skip straight to step 4 and let `psql` rebuild
everything. If the dump fails (e.g. because of a missing extension),
apply the SQL files manually first via the Supabase SQL editor:

1. SQL editor → New query → paste `database/enable_realtime.sql` → Run.
2. Repeat for `database/herbicide_lease_sheet_setup.sql`.
3. Apply each `backend/*_migration.sql` in order of filename
   (chronological).

### Step 4 — Restore the latest backup

Find the most recent `.sql.gz` in `Pineview-Maps-backups/<YYYY>/<MM>/`.

```powershell
$env:PGPASSWORD = "<new-db-password>"
gunzip -c Pineview-Maps-backups/2026/05/pineview-<latest>.sql.gz | psql `
  "postgres://postgres.<new-project-ref>@aws-0-<region>.pooler.supabase.com:5432/postgres"
```

Verify in the Supabase Table editor that `sites`, `users`,
`herbicide_lease_sheets`, etc. all have rows.

### Step 5 — Rebuild deployments

1. **Render (backend):**
   - New → **Web Service** → connect the GitHub repo.
   - Build command: `pip install -r backend/requirements.txt`
   - Start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
     (run from `backend/` working dir).
   - Add all backend env vars from your password manager. **Update
     `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
     and `DATABASE_URL` to the new project's values.**

2. **Vercel (frontend):**
   - New project → import the GitHub repo, root directory `frontend`.
   - Framework preset: Vite.
   - Add frontend env vars. **Update `VITE_API_BASE_URL` to the new
     Render URL and Supabase vars to the new project.**

3. **Update the `backups` workflow secret:**
   - Repo → Settings → Secrets → update `SUPABASE_DB_URL` to point at
     the new project (new project ref + new password).
   - Run the workflow manually to confirm it works against the new DB.

### Step 6 — Reconnect Dropbox

If the Dropbox app credentials still work, you're done. If they were
also lost:
1. <https://www.dropbox.com/developers/apps> → create / inspect app.
2. Generate a new refresh token (see `RENDER-FIX.md` if a guide
   exists, or follow Dropbox's OAuth2 docs).
3. Update `DROPBOX_REFRESH_TOKEN`, `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`
   on Render. Restart the service.

### Step 7 — Smoke test

1. Visit the new Vercel URL. Log in as admin.
2. Confirm pins render on the map.
3. Open a herbicide lease sheet → generate PDF → confirm it appears in
   Dropbox.
4. From a worker account, change a pin status → confirm it syncs in
   real time to another browser.

If all four pass, the app is fully restored.

---

## Maintenance

- **Quarterly:** download one backup and dry-run a restore into a
  throwaway local Postgres or a free Supabase project. A backup that
  has never been restored is not really a backup.
- **After schema changes:** trigger a manual backup right after
  applying any migration, in addition to the daily one.
- **Annually:** rotate the Supabase DB password and update the
  `SUPABASE_DB_URL` secret.
- **Watch the size of the `backups` branch.** For this app, daily
  dumps should compress to small enough that years of history fit
  comfortably in a single repo. If it ever balloons past ~1 GB,
  consider pruning the oldest year into a separate archive repo.
