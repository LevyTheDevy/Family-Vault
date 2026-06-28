@echo off
setlocal enabledelayedexpansion
title FamilyVault Setup

echo.
echo  FamilyVault
echo  -----------
echo.

:: Check Docker is running
docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo  Docker is not running.
    echo  Please open Docker Desktop, wait for it to start, then run this again.
    echo.
    pause
    exit /b 1
)

:: Get the first non-loopback LAN IPv4 address
set "LAN_IP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /R /C:"IPv4 Address"') do (
    if not defined LAN_IP (
        set "RAW=%%a"
        set "RAW=!RAW: =!"
        if not "!RAW!"=="127.0.0.1" set "LAN_IP=!RAW!"
    )
)

if not defined LAN_IP (
    echo  Could not detect your LAN IP address.
    echo  Please enter it manually ^(e.g. 192.168.1.100^):
    set /p LAN_IP="  IP: "
)

echo  Detected IP: %LAN_IP%
echo.

:: Check if Cloudflare tunnel is already configured in .env
set "HAS_TUNNEL="
if exist .env (
    for /f "tokens=1,* delims==" %%k in (.env) do (
        if "%%k"=="CLOUDFLARE_TOKEN" if not "%%l"=="" set "HAS_TUNNEL=1"
    )
)

if defined HAS_TUNNEL (
    echo  Cloudflare tunnel detected — keeping existing config.
    echo.
    echo  Starting FamilyVault with tunnel...
    echo  (First run downloads and builds the server - this takes a few minutes)
    docker compose --profile tunnel up -d --build
) else (
    :: Write .env so docker-compose passes the IP into the container
    echo PUBLIC_URL=http://%LAN_IP%:3000> .env
    echo  Starting FamilyVault...
    echo  (First run downloads and builds the server - this takes a few minutes)
    docker compose up -d --build
)
if %errorlevel% neq 0 (
    echo.
    echo  Something went wrong. Check the output above.
    pause
    exit /b 1
)

echo.
echo  FamilyVault is running!
echo.
echo  Admin panel  ^>  http://%LAN_IP%:3001/admin
echo  Family app   ^>  http://%LAN_IP%:3000
echo.
echo  Opening admin panel in your browser...
start "" "http://%LAN_IP%:3001/admin"

echo.
pause
