@echo off
REM Double-click this to run Spend Tracker locally. Starts the server with
REM nodemon, which auto-restarts on any .js file change; .ejs template edits
REM show up on the next page refresh with no restart needed at all.
cd /d "%~dp0"

if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
)

if not exist ".env" (
    echo Creating .env from .env.example...
    copy .env.example .env >nul
    for /f "delims=" %%k in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"') do set SECRET=%%k
    REM Match the login page's own hint text ("admin@example.com / admin123")
    REM so a fresh local setup logs in with exactly what's shown on screen.
    powershell -Command "(Get-Content .env) -replace 'SECRET_KEY=change-me-to-a-random-value', 'SECRET_KEY=%SECRET%' -replace 'ADMIN_PASSWORD=change-me', 'ADMIN_PASSWORD=admin123' | Set-Content .env"
)

echo.
echo Starting Spend Tracker at http://localhost:5051
echo Demo admin login: admin@example.com / admin123 (or ADMIN_EMAIL/ADMIN_PASSWORD from .env)
echo Edits to .ejs files show up on refresh. Editing a .js file restarts the server automatically.
echo Press Ctrl+C to stop.
echo.

start "" "http://localhost:5051"
call npm run dev
pause
