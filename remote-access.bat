@echo off
setlocal enabledelayedexpansion
title FamilyVault — Remote Access Setup

echo.
echo  FamilyVault — Remote Access Setup
echo  ----------------------------------
echo.
echo  This connects your vault to the internet via a free Cloudflare Tunnel.
echo  You need a free Cloudflare account and a domain name (~$10/year).
echo.
echo  Step 1 - Go to: https://one.dash.cloudflare.com
echo  Step 2 - Networks ^> Tunnels ^> Create a tunnel ^> Cloudflared
echo  Step 3 - Name it 'familyvault' and click Save
echo  Step 4 - Click 'Docker' under Install connector
echo           Cloudflare shows a command like:
echo             docker run cloudflare/cloudflared:latest tunnel ... --token eyJ...
echo.
set /p DOCKER_CMD=" Paste that full command here: "

:: Extract the token — the word after --token
set "CF_TOKEN="
set "GRAB_NEXT="
for %%w in (%DOCKER_CMD%) do (
    if defined GRAB_NEXT (
        set "CF_TOKEN=%%w"
        set "GRAB_NEXT="
    )
    if "%%w"=="--token" set "GRAB_NEXT=1"
)

if "%CF_TOKEN%"=="" (
    echo.
    echo  Could not find a token in that command.
    echo  Make sure you pasted the full docker run line.
    pause
    exit /b 1
)

echo.
echo  Token extracted. Starting the Cloudflare connector...

:: Preserve existing PUBLIC_URL if set
set "EXISTING_URL="
if exist .env (
    for /f "tokens=1,* delims==" %%k in (.env) do (
        if "%%k"=="PUBLIC_URL" set "EXISTING_URL=%%l"
    )
)

(
    echo PUBLIC_URL=!EXISTING_URL!
    echo CLOUDFLARE_TOKEN=%CF_TOKEN%
) > .env

docker compose --profile tunnel up -d --build

if %errorlevel% neq 0 (
    echo.
    echo  Something went wrong. Check the output above.
    pause
    exit /b 1
)

echo.
echo  -----------------------------------------------------------
echo  Connector is running. Back in the Cloudflare dashboard:
echo.
echo   - Click 'Next' (connector should now show as connected)
echo   - Under 'Public Hostname' / 'Add route' set:
echo       Subdomain: vault  (or anything, or blank for root domain)
echo       Domain:    yourdomain.com
echo       Path:      (leave empty)
echo       Service:   HTTP
echo       URL:       vault:3000
echo   - Click 'Add route'
echo  -----------------------------------------------------------
echo.
echo  Once saved, your vault is reachable at https://vault.yourdomain.com
echo  Share that URL with family members in the app.
echo  The admin panel stays local-only at http://localhost:3001/admin
echo.
pause
