@echo off
setlocal enabledelayedexpansion
title FamilyVault — Remote Access Setup

echo.
echo  FamilyVault — Remote Access Setup
echo  ----------------------------------
echo.
echo  This will connect your vault to the internet using a free Cloudflare Tunnel,
echo  so family members can reach it from anywhere — not just your home network.
echo.
echo  You will need a free Cloudflare account and a domain name.
echo  If you don't have a domain, you can register one at cloudflare.com for ~$10/year.
echo.
echo  Step 1 - Go to: https://one.dash.cloudflare.com
echo  Step 2 - Click 'Networks' in the left sidebar, then 'Tunnels'
echo  Step 3 - Click 'Create a tunnel', choose 'Cloudflared', name it 'familyvault'
echo  Step 4 - On the next screen, click 'Docker' under Install connector
echo           You will see a command like:
echo             docker run cloudflare/cloudflared:latest tunnel ... --token eyJhI...
echo           Copy just the long token at the end (starting with eyJ)
echo.
set /p CF_TOKEN=" Paste your Cloudflare tunnel token here: "

if "%CF_TOKEN%"=="" (
    echo.
    echo  No token entered. Exiting.
    pause
    exit /b 1
)

:: Preserve existing PUBLIC_URL if already set
set "EXISTING_URL="
if exist .env (
    for /f "tokens=1,* delims==" %%k in (.env) do (
        if "%%k"=="PUBLIC_URL" set "EXISTING_URL=%%l"
    )
)

:: Write .env with token so cloudflared can start
(
    echo PUBLIC_URL=%EXISTING_URL%
    echo CLOUDFLARE_TOKEN=%CF_TOKEN%
) > .env

echo.
echo  Starting the Cloudflare connector...
docker compose --profile tunnel up -d --build

if %errorlevel% neq 0 (
    echo.
    echo  Something went wrong. Check the output above.
    pause
    exit /b 1
)

echo.
echo  ---------------------------------------------------------------
echo  The connector is running. Go back to the Cloudflare dashboard:
echo.
echo    - Click 'Next' (the connector should now show as connected)
echo    - Under 'Public Hostname', set:
echo        Subdomain: vault  (or anything you like)
echo        Domain:    yourdomain.com
echo        Service:   HTTP   URL: vault:3000
echo    - Click 'Save tunnel'
echo  ---------------------------------------------------------------
echo.
set /p PUBLIC_URL=" What is the full public URL you just set up? (e.g. https://vault.yourdomain.com): "

if "%PUBLIC_URL%"=="" (
    echo.
    echo  No URL entered — tunnel is running but PUBLIC_URL is not set.
    pause
    exit /b 1
)

:: Update .env with final values
(
    echo PUBLIC_URL=%PUBLIC_URL%
    echo CLOUDFLARE_TOKEN=%CF_TOKEN%
) > .env

echo.
echo  Done! Your vault is now accessible at: %PUBLIC_URL%
echo.
echo  Share this URL with family members when they set up the app.
echo  The admin panel remains local-only at http://localhost:3001/admin
echo.
pause
