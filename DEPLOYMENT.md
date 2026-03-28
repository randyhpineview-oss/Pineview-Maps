# Pineview Actual Data Collaboration - Deployment Guide

## GitHub Pages Deployment Setup

This guide will help you deploy the Pineview field mapping app to GitHub Pages using GitHub Actions.

### Prerequisites

1. **GitHub Repository**: Push your code to a GitHub repository
2. **Google Maps API Key**: Get a key from [Google Cloud Console](https://console.cloud.google.com/)
3. **Backend API**: Deploy your backend API to a hosting service (Heroku, Railway, etc.)

### Step 1: Repository Setup

1. Create a new GitHub repository or use an existing one
2. Push your code to the `main` branch:
   ```bash
   git add .
   git commit -m "Initial commit with GitHub Actions deployment"
   git push origin main
   ```

### Step 2: Configure GitHub Secrets

Go to your GitHub repository → Settings → Secrets and variables → Actions

Add these repository secrets:

- **`VITE_GOOGLE_MAPS_API_KEY`**: Your Google Maps API key
- **`VITE_API_BASE_URL`**: Your backend API URL (e.g., `https://your-backend.herokuapp.com`)

### Step 3: Enable GitHub Pages

1. Go to repository Settings → Pages
2. Set Source to "GitHub Actions"
3. Save the configuration

### Step 4: Deploy

The deployment will automatically trigger when you push to the `main` branch. You can also manually trigger it:

1. Go to Actions tab in your repository
2. Select "Deploy to GitHub Pages" workflow
3. Click "Run workflow"

### Step 5: Access Your App

Once deployed, your app will be available at:
`https://yourusername.github.io/your-repository-name/`

## Local Development

### Backend Setup
```bash
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1  # Windows
pip install -r requirements.txt
uvicorn app.main:app --reload
```

### Frontend Setup
```bash
cd frontend
npm install
npm run dev
```

## Configuration Files

### Frontend Environment Variables

Create `frontend/.env` for local development:
```bash
VITE_API_BASE_URL=http://localhost:8000
VITE_GOOGLE_MAPS_API_KEY=your_google_maps_api_key
```

### Key Features Configured

✅ **Map Center**: Set to Fort St. John, BC (56.2498, -120.8464)
✅ **Immediate Loading**: Cached data loads instantly, server sync happens in background
✅ **GitHub Actions**: Automated deployment on push to main branch
✅ **PWA Support**: App can be installed on mobile devices
✅ **Offline Support**: Works offline with cached data

## Troubleshooting

### Common Issues

1. **Map not loading**: Check your Google Maps API key in GitHub secrets
2. **API errors**: Verify your backend URL in GitHub secrets
3. **404 on refresh**: GitHub Pages is configured correctly for SPA routing
4. **Build fails**: Check the Actions tab for detailed error logs

### Build Optimization

The build is optimized with:
- Vendor chunk splitting (React, Google Maps)
- Asset optimization
- Source map disabled for production
- Proper base path for GitHub Pages

## Manual Deployment

If you prefer manual deployment:

```bash
cd frontend
npm run build
# Upload the dist/ folder to your hosting service
```

## Support

For issues with:
- **Google Maps**: Check API key and billing setup
- **GitHub Actions**: Review workflow logs in Actions tab
- **Backend connectivity**: Verify CORS settings and API URL
