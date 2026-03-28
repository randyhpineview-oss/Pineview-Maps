# Pineview Development Startup Script
# Run this script to start both backend and frontend

Write-Host "Starting Pineview Actual Data Collaboration..." -ForegroundColor Green

# Get the script directory
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPath = Join-Path $scriptDir "backend"
$frontendPath = Join-Path $scriptDir "frontend"

Write-Host "Script directory: $scriptDir" -ForegroundColor Gray
Write-Host "Backend path: $backendPath" -ForegroundColor Gray
Write-Host "Frontend path: $frontendPath" -ForegroundColor Gray

# Check if paths exist
if (-not (Test-Path $backendPath)) {
    Write-Host "Error: Backend directory not found at $backendPath" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $frontendPath)) {
    Write-Host "Error: Frontend directory not found at $frontendPath" -ForegroundColor Red
    exit 1
}

# Start backend
Write-Host "Starting backend API..." -ForegroundColor Yellow
$backendCmd = "Set-Location '$backendPath'; if (Test-Path '.\.venv\Scripts\Activate.ps1') { .\.venv\Scripts\Activate.ps1 } else { Write-Host 'Virtual environment not found. Run: python -m venv .venv' -ForegroundColor Red; Read-Host 'Press Enter to continue' }; uvicorn app.main:app --reload --host 0.0.0.0 --port 8000"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $backendCmd

# Wait a moment for backend to start
Start-Sleep -Seconds 3

# Start frontend
Write-Host "Starting frontend..." -ForegroundColor Yellow
$frontendCmd = "Set-Location '$frontendPath'; npm run dev"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $frontendCmd

Write-Host "Both services starting..." -ForegroundColor Green
Write-Host "Backend: http://localhost:8000" -ForegroundColor Cyan
Write-Host "Frontend: http://localhost:5173" -ForegroundColor Cyan
Write-Host "Press any key to continue..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
