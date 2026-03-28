# Pineview Always-On Deployment Instructions

This guide walks you through setting up the free always-on deployment using Supabase, Render, Vercel, and GitHub Actions.

## Prerequisites

- GitHub account
- Supabase account (free)
- Render account (free)
- Vercel account (free)
- Google Maps API key (existing)

---

## Phase 1: Account Setup (15 minutes)

### 1.1 Supabase Setup (5 min)

1. Go to [supabase.com](https://supabase.com) and create an account
2. Click "New Project"
3. Fill in:
   - **Name**: `pineview-field-app`
   - **Database Password**: Choose a strong password
   - **Region**: Choose closest to you
4. Wait for project to be created (~2 minutes)
5. Go to **Settings** → **API** to get your credentials:
   - **Project URL**: `https://[your-ref].supabase.co`
   - **anon/public key**: Copy this
   - **service_role key**: Copy this (keep secret!)
6. Enable Email/Password auth in **Authentication** → **Providers**

### 1.2 Render Setup (3 min)

1. Go to [render.com](https://render.com) and sign up with GitHub
2. Click "New +" → "Web Service"
3. Connect your GitHub repository
4. Configure:
   - **Name**: `pineview-backend`
   - **Environment**: `Python 3`
   - **Build Command**: `cd backend && pip install -r requirements.txt`
   - **Start Command**: `cd backend && uvicorn app.main:app --host 0.0.0.0 --port $PORT`
5. Add Environment Variables (see Phase 4)
6. Click "Create Web Service"

### 1.3 Vercel Setup (3 min)

1. Go to [vercel.com](https://vercel.com) and sign up with GitHub
2. Click "Import Project"
3. Select your repository
4. Configure:
   - **Root Directory**: `frontend`
   - **Framework Preset**: `React`
5. Add Environment Variables (see Phase 4)
6. Click "Deploy"

### 1.4 UptimeRobot Setup (4 min)

1. Go to [uptimerobot.com](https://uptimerobot.com) and create free account
2. Click "Add New Monitor"
3. Configure:
   - **Monitor Type**: HTTP(s)
   - **Friendly Name**: `Pineview Backend`
   - **URL**: `https://your-backend.onrender.com/health` (replace with your Render URL after deployment)
   - **Monitoring Interval**: 5 minutes
   - **Timeout**: 30 seconds
4. Click "Create Monitor"

---

## Phase 2: Database Schema (10 minutes)

### 2.1 Run SQL Migrations in Supabase

1. In Supabase dashboard, go to **SQL Editor**
2. Click "New Query"
3. Paste the following schema:

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table (public)
CREATE TABLE public."users" (
    instance_id UUID PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    role VARCHAR(50) DEFAULT 'worker',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Sites table
CREATE TABLE sites (
    id SERIAL PRIMARY KEY,
    pin_type VARCHAR(50) NOT NULL,
    lsd VARCHAR(255),
    client VARCHAR(255),
    area VARCHAR(255),
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    gate_code VARCHAR(255),
    phone_number VARCHAR(50),
    notes TEXT,
    source VARCHAR(100),
    source_name VARCHAR(255),
    raw_attributes JSONB,
    approval_state VARCHAR(50) DEFAULT 'pending_review',
    status VARCHAR(50) DEFAULT 'not_inspected',
    pending_pin_type VARCHAR(50),
    last_inspected_at TIMESTAMP,
    created_by_user_id INTEGER REFERENCES public.users(instance_id),
    approved_by_user_id INTEGER REFERENCES public.users(instance_id),
    deleted_at TIMESTAMP,
    deleted_by_user_id INTEGER REFERENCES public.users(instance_id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Site updates table
CREATE TABLE site_updates (
    id SERIAL PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    status VARCHAR(50),
    note TEXT,
    created_by_user_id INTEGER REFERENCES public.users(instance_id),
    sync_status VARCHAR(50) DEFAULT 'synced',
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_sites_latitude_longitude ON sites(latitude, longitude);
CREATE INDEX idx_sites_client ON sites(client);
CREATE INDEX idx_sites_area ON sites(area);
CREATE INDEX idx_sites_approval_state ON sites(approval_state);
CREATE INDEX idx_sites_status ON sites(status);
CREATE INDEX idx_sites_deleted_at ON sites(deleted_at);
CREATE INDEX idx_site_updates_site_id ON site_updates(site_id);
CREATE INDEX idx_site_updates_created_at ON site_updates(created_at);
```

4. Click "Run" to execute

### 2.2 Enable Row Level Security (RLS)

Run these additional commands:

```sql
-- Enable RLS on sites table
ALTER TABLE sites ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read all sites
CREATE POLICY "Allow authenticated read access" ON sites
    FOR SELECT USING (auth.role() = 'authenticated');

-- Allow authenticated users to insert sites
CREATE POLICY "Allow authenticated insert access" ON sites
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- Allow authenticated users to update sites
CREATE POLICY "Allow authenticated update access" ON sites
    FOR UPDATE USING (auth.role() = 'authenticated');

-- Allow authenticated users to delete sites
CREATE POLICY "Allow authenticated delete access" ON sites
    FOR DELETE USING (auth.role() = 'authenticated');

-- Enable RLS on site_updates
ALTER TABLE site_updates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow authenticated read access" ON site_updates
    FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Allow authenticated insert access" ON site_updates
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Allow authenticated update access" ON site_updates
    FOR UPDATE USING (auth.role() = 'authenticated');

CREATE POLICY "Allow authenticated delete access" ON site_updates
    FOR DELETE USING (auth.role() = 'authenticated');
```

### 2.3 Auto-Sync Auth Users to Public Users

This is the recommended Supabase approach - automatically mirror auth.users to public.users:

```sql
-- 1) Create function to sync new auth users to public.users
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public."users" ("instance_id", "email", "name")
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data->>'name',
      new.raw_user_meta_data->>'full_name',
      split_part(new.email, '@', 1)
    )
  )
  on conflict ("instance_id") do nothing;

  return new;
end;
$$;

-- 2) Ensure unique constraint on instance_id
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_instance_id_key'
  ) then
    alter table public."users"
    add constraint "users_instance_id_key" unique ("instance_id");
  end if;
end $$;

-- 3) Create trigger to auto-sync on user signup
drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();
```

**How it works**: When a user signs up through Supabase Auth, they're automatically added to `auth.users`. This trigger copies them to your `public.users` table with their `instance_id` (UUID), email, and name from metadata.

---

## Phase 3: Environment Configuration

### 3.1 Backend Environment Variables

On Render, add these environment variables:

```
DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT-REF].supabase.co:5432/postgres
SUPABASE_URL=https://[YOUR-PROJECT-REF].supabase.co
SUPABASE_ANON_KEY=your-anon-key-here
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
ALLOWED_ORIGINS=https://your-app.vercel.app,https://your-app.vercel.app,http://localhost:5173
```

**Important**: Replace placeholders with actual values from Supabase.

### 3.2 Frontend Environment Variables

In Vercel, add these environment variables:

```
VITE_API_BASE_URL=https://your-backend.onrender.com
VITE_GOOGLE_MAPS_API_KEY=your-google-maps-api-key
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

---

## Phase 4: GitHub Secrets Setup

Go to your GitHub repository → Settings → Secrets and variables → Actions

Add these repository secrets:

### For Frontend Deployment (GitHub Pages or Vercel)
- `VITE_GOOGLE_MAPS_API_KEY`: Your Google Maps API key
- `VITE_API_BASE_URL`: Your backend URL (after Render deployment)

### For Backend Deployment (Render)
- `RENDER_DEPLOY_HOOK`: Webhook URL from Render (found in Render dashboard)

Note: For Render, you can directly set environment variables in the Render dashboard instead of using GitHub secrets.

---

## Phase 5: Initial Deployment

### 5.1 Deploy Backend to Render

1. After creating the Render Web Service, it will automatically deploy
2. Wait for deployment to complete (~5 minutes)
3. Copy your Render URL: `https://pineview-backend.onrender.com`
4. Test health endpoint: `https://pineview-backend.onrender.com/health`
5. Should return: `{"status": "healthy", "timestamp": "...", "service": "pineview-backend"}`

### 5.2 Deploy Frontend to Vercel

1. After connecting GitHub, Vercel will automatically deploy
2. Wait for deployment to complete (~3 minutes)
3. Copy your Vercel URL: `https://pineview-app.vercel.app`
4. Open the URL to verify the app loads

### 5.3 Configure UptimeRobot

1. Edit your UptimeRobot monitor
2. Update the URL to your actual Render backend URL
3. Save

---

## Phase 6: Post-Deployment Setup

### 6.1 Create Admin User

After first successful connection to your deployed app:

1. Open your deployed frontend
2. Since Supabase auth is configured, users can register
3. Create an admin account through Supabase dashboard:
   - Go to Supabase → Authentication → Users
   - Add a new user with email and password
   - Set `user_metadata` → `{"role": "admin"}`
4. The trigger will automatically create the corresponding entry in `public.users`

Alternatively, promote an existing user via the database:

```sql
UPDATE public.users SET role = 'admin' WHERE email = 'your-email@example.com';
```

### 6.2 Test the Application

1. Log in to your deployed app
2. Verify you can:
   - View sites on map
   - Add new pins
   - Update site status
   - Admin functions (if admin role)
3. Go offline and verify offline functionality works
4. Reconnect and verify sync works

---

## Phase 7: Keep-Alive Verification

### 7.1 UptimeRobot Monitoring

1. In UptimeRobot dashboard, verify your monitor shows "UP" status
2. Check that it's been monitoring for at least 5 minutes
3. View uptime statistics

### 7.2 GitHub Actions Keep-Alive

1. Go to GitHub repository → Actions
2. You should see "Keep Backend Alive" workflow running every 10 minutes
3. Check logs to ensure successful pings

---

## Phase 8: Free Tier Limits & Optimization

### Render Free Tier
- **750 hours/month** (enough for 24/7 = 720 hours)
- Sleeps after 15 minutes of inactivity
- Our keep-alive prevents this

### UptimeRobot Free Tier
- **50 monitors**
- **5-minute intervals**
- Email notifications

### GitHub Actions Free Tier
- **2,000 minutes/month**
- Our keep-alive uses ~144 minutes/month (every 10 min)

### Vercel Free Tier
- **100GB bandwidth**
- Unlimited deployments
- Automatic HTTPS

### Supabase Free Tier
- **500MB database**
- **50K users**
- **10K authentications/month**
- **2GB file storage**

---

## IMPORTANT: Local Development Preservation

Your local offline version remains fully functional:

1. **Local SQLite**: Keep using `backend/.env` with SQLite for local dev
2. **Demo Auth**: Continue using `X-Demo-User` header for local testing
3. **No Changes Needed**: Just don't set Supabase env vars locally

To test locally with Supabase:
1. Copy Supabase credentials to `backend/.env`
2. App will automatically use Supabase instead of demo users

---

## Troubleshooting

### Backend Won't Start on Render
- Check logs in Render dashboard
- Ensure `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set
- Verify `DATABASE_URL` format is correct
- Wait 10 minutes on first deploy (cold start)

### Frontend Can't Connect to Backend
- Check `VITE_API_BASE_URL` in Vercel environment
- Ensure CORS is configured on backend (`ALLOWED_ORIGINS`)
- Verify backend is running: `curl https://your-backend.onrender.com/health`

### UptimeRobot Not Working
- Ensure backend URL is correct and accessible
- Check `/health` endpoint returns 200 OK
- Verify curl command works manually

### GitHub Actions Keep-Alive Not Running
- Verify workflow file is in `.github/workflows/keep-alive.yml`
- Check repository secrets are set (`BACKEND_URL`)
- Look at Actions tab for workflow history

### Supabase Auth Not Working
- Ensure Supabase is initialized with Email/Password provider
- Check JWT secret is configured in Supabase (should be auto-generated)
- Verify `SUPABASE_ANON_KEY` and `SUPABASE_URL` are correct in frontend
- Ensure the trigger function from section 2.3 is installed

### Map Not Loading in Production
- Verify Google Maps API key is valid
- Check API key restrictions allow your Vercel domain
- Ensure billing is enabled on Google Cloud

---

## Rollback Plan

If you need to revert to offline-only mode:

1. **Backend**: Remove Supabase env vars → automatically falls back to SQLite
2. **Frontend**: Remove Supabase env vars → automatically uses demo auth
3. **Keep running Render/Vercel**: They'll continue working if env vars still set

---

## Support

For issues:
- Check GitHub Actions logs: Repository → Actions
- Check Render logs: Render dashboard → your service → Logs
- Check Vercel logs: Vercel dashboard → your project → Logs
- Check UptimeRobot: Dashboard → Monitors → History
- Check Supabase: Logs in Database → Logs

---

## Next Steps After Deployment

1. Add custom domain to Vercel (free)
2. Set up email notifications in UptimeRobot
3. Configure automated backups in Supabase
4. Add more users through Supabase Auth
5. Monitor free tier usage monthly
6. Consider upgrading if approaching limits