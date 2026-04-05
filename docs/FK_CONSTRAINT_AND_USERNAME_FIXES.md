# Site Inspection App - Foreign Key Constraint & Username Display Fixes

## Summary

This document records the fixes applied to handle Supabase Auth users with PostgreSQL foreign key constraints, and the implementation of username display from user metadata instead of email prefixes.

## Date: April 2, 2026

---

## Problem 1: Foreign Key Constraint Violations

### Issue
When users authenticate via Supabase, their user IDs exist in Supabase Auth but NOT in the local application's `users` table. This caused 500 errors when trying to create sites, delete sites, update status, or approve sites because the database foreign key constraints failed.

### Root Cause
All `*_user_id` fields in the database have foreign key constraints referencing the local `users` table:
- `sites.created_by_user_id`
- `sites.approved_by_user_id`
- `sites.last_inspected_by_user_id`
- `sites.deleted_by_user_id`
- `site_updates.created_by_user_id`

### Solution
Modified all endpoints to check if the user exists in the local database before setting the foreign key:

```python
# Only set created_by_user_id if user exists in local DB to avoid FK constraint
if current_user.id:
    local_user = db.query(User).filter(User.id == current_user.id).first()
    if local_user:
        site.created_by_user_id = current_user.id
```

### Files Modified
- `backend/app/main.py` - All endpoints that set user IDs now check for local user existence

### Endpoints Fixed
1. `POST /api/sites` - Create pin
2. `DELETE /api/sites/{site_id}` - Delete pin (soft delete)
3. `PATCH /api/sites/{site_id}/status` - Update pin status
4. `POST /api/sites/{site_id}/approval` - Approve/reject pin

---

## Problem 2: Username Display from Email Prefix

### Issue
The app was displaying usernames derived from email prefixes (e.g., "Randyh.Pineview" from "randyh.pineview@gmail.com") instead of the custom username set in Supabase user metadata (e.g., "Randy").

### Root Cause
The auth code was using `email.split("@")[0].title()` to generate the username instead of checking `user_metadata.name`.

### Solution
Modified `backend/app/auth.py` to extract the username from JWT payload's `user_metadata.name` field:

```python
user_metadata = payload.get("user_metadata", {})
# Use user metadata name first, then fall back to email prefix
user_name = user_metadata.get("name", user_email.split("@")[0].title()) if user_email else "User"
```

### Files Modified
- `backend/app/auth.py` - User extraction from JWT payload
- `backend/app/main.py` - Store `last_inspected_by_name` alongside `last_inspected_by_user_id`
- `backend/app/schemas.py` - Added `last_inspected_by_name` to SiteRead schema
- `backend/app/models.py` - Added `last_inspected_by_name` column to Site model
- `frontend/src/components/SiteDetailSheet.jsx` - Display `last_inspected_by_name`
- `frontend/src/App.jsx` - Display username in header from user metadata

---

## Database Schema Changes

### Column Added
```sql
ALTER TABLE sites ADD COLUMN IF NOT EXISTS last_inspected_by_name VARCHAR(255);
```

This allows storing the inspector's username without requiring a foreign key relationship.

---

## Key Insight: Supabase Auth vs Local Users

The application uses Supabase for authentication but has its own `users` table for data relationships. These are separate:
- **Supabase Auth**: Stores user credentials, email, metadata
- **Local `users` table**: Used for foreign key relationships in the application

When a user authenticates via Supabase, they get a user ID from Supabase. But for the application to track "who created this site" or "who approved this site", that user needs to exist in the local `users` table with the same ID.

### Current Workaround
The application now gracefully handles this by:
1. Checking if the user exists locally before setting FKs
2. Storing user identifiers (email, name) as text fields where possible
3. Only setting FK relationships when the user is guaranteed to exist locally

### Future Enhancement
To properly track user actions with full audit trails, consider:
1. Syncing Supabase users to the local database on first login
2. Or using Supabase Auth's user ID as the primary key in the local `users` table

---

## Testing Checklist

After any future updates, verify:
- [ ] Create a new pin
- [ ] Update pin status to "Inspected"
- [ ] Verify "Last inspected by" shows correct username (not email)
- [ ] Delete a pin (soft delete)
- [ ] Approve a pending pin
- [ ] Check header shows username correctly

---

## Related Files for Reference

### Backend
- `backend/app/auth.py` - JWT decoding and user extraction
- `backend/app/main.py` - All API endpoints
- `backend/app/models.py` - Database models
- `backend/app/schemas.py` - Pydantic schemas

### Frontend
- `frontend/src/App.jsx` - Header username display
- `frontend/src/components/SiteDetailSheet.jsx` - Site details panel
