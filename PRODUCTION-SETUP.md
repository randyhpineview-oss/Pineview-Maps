# Production Setup - Render + Supabase (No Database Connection)

## The Fix

The backend now uses **Supabase REST API mode** for production, which avoids the IPv6 network issue on Render. Your local SQLite development environment is completely unchanged.

## Updated Render Configuration

### Step 1: Update Render Environment Variables

In Render Dashboard → Your Backend Service → Environment:

**Remove or ignore the DATABASE_URL variable** - it's not needed for production.

Instead, add these variables:

```
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=your-anon-key-here
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
ALLOWED_ORIGINS=https://your-app.vercel.app,http://localhost:5173
```

### Step 2: Redeploy

1. Click "Manual Deploy" or push a new commit to trigger redeploy
2. Wait 3-5 minutes for deployment
3. Check Logs - should see `Application startup complete`

### Step 3: Test Health Endpoint

```bash
curl https://your-backend.onrender.com/health
```

Should return:
```json
{"status": "healthy", "timestamp": "...", "service": "pineview-backend"}
```

## How It Works

- **Local (SQLite)**: Uses demo users with X-Demo-User header
- **Production (Supabase)**: Uses JWT tokens from Supabase Auth
- **No direct database connection**: Avoids IPv6 issues entirely

## Local Development (Unchanged)

Your offline testing still works exactly as before:

```bash
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Then in another terminal:

```bash
cd frontend
npm run dev
```

Everything works with SQLite locally - no Supabase needed for development.

## What Changed in Code

1. **requirements.txt**: Removed `psycopg2-binary`, added `httpx`
2. **database.py**: SQLite only for local, no DB connection for production
3. **auth.py**: Handles both demo users (local) and JWT tokens (production)
4. **supabase_client.py**: New REST API client (for future use)

## Next Steps

1. Update Render environment variables (remove DATABASE_URL)
2. Redeploy
3. Test health endpoint
4. Once working, we'll deploy the frontend to Vercel
5. Then test the complete flow

## If It Still Doesn't Work

1. Verify SUPABASE_URL is correct (check Supabase dashboard)
2. Verify SUPABASE_ANON_KEY is correct (Settings → API)
3. Check Render logs for any errors
4. Ensure you're not setting DATABASE_URL (remove it if present)
