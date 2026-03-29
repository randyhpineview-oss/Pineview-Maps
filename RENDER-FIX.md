# Render Connection Fix - Database URL Format

## The Issue

Render cannot connect to Supabase because the DATABASE_URL format was incorrect. The connection string needs the `?sslmode=require` parameter at the end.

## Quick Fix (2 minutes)

### Step 1: Get Your Supabase Connection String

1. Go to Supabase Dashboard → Your Project
2. Click **Settings** → **Database**
3. Under "Connection string", select **URI** tab
4. Copy the connection string (looks like: `postgresql://postgres:[password]@db.xxx.supabase.co:5432/postgres`)

### Step 2: Update Render Environment Variable

1. Go to Render Dashboard → Your Pineview Backend Service
2. Click **Environment** (or **Settings** → **Environment Variables**)
3. Find the `DATABASE_URL` variable
4. **Replace it with this format** (paste your Supabase URI and add `?sslmode=require` at the end):

```
postgresql://postgres:YOUR_PASSWORD@db.YOUR_PROJECT_REF.supabase.co:5432/postgres?sslmode=require
```

**Example:**
```
postgresql://postgres:abc123xyz@db.dppjsabododdnzndhxdq.supabase.co:5432/postgres?sslmode=require
```

5. Click **Save** or **Update**
6. Render will automatically redeploy with the new connection string

### Step 3: Verify Connection

After Render redeploys (2-3 minutes):

1. Go to **Logs** tab in Render
2. You should see: `Application startup complete`
3. Test the health endpoint: `curl https://your-backend.onrender.com/health`
4. Should return: `{"status": "healthy", "timestamp": "...", "service": "pineview-backend"}`

## What Changed in the Code

- **database.py**: Added connection pool settings, SSL configuration, and health checks
- **.env.example**: Updated to show correct DATABASE_URL format with `?sslmode=require`

## Why This Works

- `?sslmode=require` tells psycopg2 to use SSL for the connection
- `pool_pre_ping=True` tests connections before using them (handles stale connections)
- `pool_recycle=3600` recycles connections after 1 hour (prevents timeout issues)
- Connection timeout of 10 seconds prevents hanging on network issues

## If It Still Doesn't Work

1. **Check password**: Ensure the password in DATABASE_URL matches your Supabase password
2. **Check project ref**: Ensure `db.dppjsabododdnzndhxdq.supabase.co` matches your actual Supabase project
3. **Check port**: Should always be `5432`
4. **Check database name**: Should be `postgres` (default)
5. **Check Supabase status**: Go to supabase.com and verify your project is running

## Connection String Format Reference

```
postgresql://[user]:[password]@[host]:[port]/[database]?sslmode=require

Where:
- user = postgres (default)
- password = Your Supabase database password
- host = db.YOUR_PROJECT_REF.supabase.co
- port = 5432
- database = postgres
- sslmode=require = Required for Render to Supabase connection
```

## Next Steps

1. Update DATABASE_URL in Render
2. Wait for redeploy
3. Test health endpoint
4. If successful, your backend is ready for frontend deployment
5. Then update Vercel frontend with correct backend URL
