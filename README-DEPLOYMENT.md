# Pineview Always-On Deployment - Quick Start Guide

Your Pineview app has been updated with the Always-On Deployment capability. This README provides the quickest path to getting your app running 24/7 for free.

## What's Changed

The codebase now supports:
- **Dual-mode backend**: SQLite (local) + Supabase (production)
- **Flexible authentication**: Demo users (local) + Supabase JWT (production)
- **Keep-alive system**: UptimeRobot + GitHub Actions (dual redundancy)
- **Health check endpoint**: For monitoring and uptime
- **Automated deployments**: GitHub Actions for zero-downtime updates

---

## 3-Step Deployment Process

### Step 1: Create Supabase Project (5 minutes)

1. Go to [supabase.com](https://supabase.com) → Sign up
2. Create new project: `pineview-field-app`
3. After creation, go to **Settings → API**
4. Copy these values:
   - `SUPABASE_URL`: `https://xxx.supabase.co`
   - `SUPABASE_ANON_KEY`: (anon public key)
   - `SUPABASE_SERVICE_ROLE_KEY`: (service role key)
5. In Supabase SQL Editor, run the schema from `DEPLOYMENT-INSTRUCTIONS.md` section 2.1
6. Enable Email/Password auth in **Authentication → Providers**

### Step 2: Deploy Backend to Render (5 minutes)

1. Go to [render.com](https://render.com) → Sign up with GitHub
2. **New Web Service** → Connect your Pineview repository
3. Settings:
   - **Name**: `pineview-backend`
   - **Env**: `Python 3`
   - **Build**: `cd backend && pip install -r requirements.txt`
   - **Start**: `cd backend && uvicorn app.main:app --host 0.0.0.0 --port $PORT`
4. Add **Environment Variables** (in Render dashboard):
   ```
   DATABASE_URL=postgresql://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres
   SUPABASE_URL=https://[PROJECT-REF].supabase.co
   SUPABASE_ANON_KEY=your-anon-key
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   ALLOWED_ORIGINS=https://your-app.vercel.app,http://localhost:5173
   ```
5. Click **Create Web Service** → Wait ~5 minutes for deployment
6. Test: `https://your-backend.onrender.com/health` should return JSON

### Step 3: Deploy Frontend to Vercel (3 minutes)

1. Go to [vercel.com](https://vercel.com) → Sign up with GitHub
2. **Import Project** → Select your Pineview repository
3. Settings:
   - **Root**: `frontend`
   - **Framework**: `React`
4. Add **Environment Variables** (in Vercel dashboard):
   ```
   VITE_API_BASE_URL=https://your-backend.onrender.com
   VITE_GOOGLE_MAPS_API_KEY=your-google-maps-key
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-key
   ```
5. Click **Deploy** → Wait ~3 minutes
6. Your app is live at `https://your-app.vercel.app`

---

## Step 4: Configure Keep-Alive (2 minutes)

### UptimeRobot (Free)
1. Go to [uptimerobot.com](https://uptimerobot.com)
2. **Add Monitor** → HTTP(s)
   - **URL**: `https://your-backend.onrender.com/health`
   - **Interval**: 5 minutes
3. Save → Your backend stays warm 24/7

### GitHub Actions (Automatic)
- Already configured in `.github/workflows/keep-alive.yml`
- Runs every 10 minutes automatically
- Add `BACKEND_URL` secret in GitHub repo settings → Secrets → Actions

---

## ✅ Your Offline Testing Still Works!

**Local development unchanged**: Your current offline setup continues to work exactly as before:
- SQLite database in `backend/data/pineview.db`
- Demo authentication via `X-Demo-User` header
- No environment variables required

**Production features activate automatically** when you set Supabase credentials on Render. Your local dev environment never touches production data.

---

## 📁 New Files & Changes

### New Configuration Files
- `backend/.env.example` - Updated with Supabase settings
- `frontend/.env.example` - Updated with Supabase auth
- `DEPLOYMENT-INSTRUCTIONS.md` - Detailed setup guide
- `.github/workflows/backend-deploy.yml` - Auto-deploy on git push
- `.github/workflows/keep-alive.yml` - Keep backend alive

### Updated Files
- `backend/app/config.py` - Added Supabase support
- `backend/app/database.py` - Handles both SQLite & PostgreSQL
- `backend/app/auth.py` - Supports both demo & Supabase auth
- `backend/requirements.txt` - Added `supabase` & `pyjwt`
- `backend/app/main.py` - Added `/health` endpoint
- `frontend/src/lib/api.js` - Supports both auth modes

---

## 🚀 Quick Deployment Checklist

- [ ] Create Supabase project + run SQL schema
- [ ] Deploy backend to Render with environment variables
- [ ] Deploy frontend to Vercel with environment variables
- [ ] Test backend health endpoint
- [ ] Set up UptimeRobot monitor
- [ ] Add BACKEND_URL secret to GitHub Actions
- [ ] Open your Vercel URL and verify the app works
- [ ] Test offline/online sync on mobile

---

## 💰 Free Tier Limits (All Free)

| Service | Limit | Our Usage |
|---------|-------|-----------|
| Render | 750 hrs/month | ~720 hrs (always on) |
| Vercel | 100 GB bandwidth | ~5-10 GB/month typical |
| Supabase | 500 MB database | ~50-100 MB typical |
| UptimeRobot | 50 monitors | 1 monitor used |
| GitHub Actions | 2,000 mins/month | ~144 mins (keep-alive) |

---

## 🆘 Testing Your Deployment

1. **Backend Health**: `curl https://your-backend.onrender.com/health`
2. **API Test**: `curl https://your-backend.onrender.com/api/session -H "X-Demo-User: worker"`
3. **Frontend**: Open your Vercel URL, map should load
4. **Auth**: Try logging in with Supabase (if configured) or demo user selection

---

## 📖 Detailed Documentation

See `DEPLOYMENT-INSTRUCTIONS.md` for:
- Complete step-by-step setup
- Database schema & RLS policies
- Troubleshooting guide
- Admin user creation
- Rollback instructions

---

## 🎯 Next Actions

1. **Right now**: Create Supabase project
2. **Next 10 min**: Deploy to Render
3. **Next 5 min**: Deploy to Vercel
4. **Next 2 min**: Set up UptimeRobot
5. **Done**: Your app is always on! 🎉

---

**Questions?** Check `DEPLOYMENT-INSTRUCTIONS.md` for detailed troubleshooting and setup steps.