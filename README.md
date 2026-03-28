# Pineview Actual Data Collaboration

A lightweight field mapping app for Pineview crews with a Python API, a mobile-first home-screen web app, Google Maps satellite view, status-colored pins, KML import, admin approvals, bulk status reset, and offline-friendly queued edits.

## Features

- Google Maps satellite map with green and red pins
- Pin detail card with LSD, client, area, notes, gate code, phone number, and `Get Directions`
- Worker status updates with `Not inspected` and `Inspected`
- Pending approval flow for new `LSD`, `Water`, and `Quad access` pins
- Admin review queue and bulk reset by client or area
- KML import for initial site inventory
- Installable PWA shell with cached app assets, local site cache, and queued offline edits
- Demo role switching for `admin`, `office`, and `worker`

## Project Structure

- `backend/` FastAPI API and data model
- `frontend/` React PWA frontend

## Backend Setup

1. Open a terminal in `backend`
2. Create a virtual environment
3. Install dependencies
4. Start the API server

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload
```

The API runs on `http://localhost:8000`.

### Backend configuration

The backend uses SQLite by default for local development and can be pointed at PostgreSQL with `DATABASE_URL`.

Example `DATABASE_URL` values:

- SQLite: `sqlite:///./data/pineview.db`
- PostgreSQL: `postgresql+psycopg://username:password@localhost:5432/pineview`

Optional environment variables:

- `DATABASE_URL`
- `ALLOWED_ORIGINS`

## Frontend Setup

1. Open a terminal in `frontend`
2. Install dependencies
3. Start the Vite dev server

```powershell
npm install
npm run dev
```

The frontend runs on `http://localhost:5173`.

### Frontend configuration

Create a `.env` file in `frontend` with:

```bash
VITE_API_BASE_URL=http://localhost:8000
VITE_GOOGLE_MAPS_API_KEY=your_google_maps_api_key
```

## How to Use

### Demo roles

Use the role selector in the app header to switch between:

- `worker`
- `office`
- `admin`

### KML import

1. Switch to `office` or `admin`
2. Open the admin panel
3. Upload your existing KML file
4. Imported placemarks appear as approved `LSD` pins

### Status workflow

- Green pin = `Not inspected`
- Red pin = `Inspected`
- Admin bulk reset sets filtered groups back to green `Not inspected`

### Pending pins

Workers can add:

- `LSD`
- `Water`
- `Quad access`

New pins appear in a pending state and require admin or office approval.

## Notes

- Google Maps satellite is the primary connected map experience.
- Offline data edits and local site browsing are supported.
- Guaranteed offline Google satellite imagery is not provided by the app.
- For production use, replace the demo role switch with real authentication.
