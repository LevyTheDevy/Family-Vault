#!/bin/sh
set -e

echo ""
echo " FamilyVault"
echo " -----------"
echo ""

# Check Docker is available and running
if ! docker info >/dev/null 2>&1; then
    echo " Docker is not running."
    echo " Please install Docker (https://docs.docker.com/get-docker/) or start Docker Desktop, then run this again."
    echo ""
    exit 1
fi

# Detect LAN IP — try hostname -I first (Linux), fall back to ifconfig (Mac)
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "$LAN_IP" ]; then
    LAN_IP=$(ifconfig 2>/dev/null | grep 'inet ' | grep -v '127.0.0.1' | awk '{print $2}' | head -1)
fi

if [ -z "$LAN_IP" ]; then
    echo " Could not detect your LAN IP address."
    printf " Please enter it manually (e.g. 192.168.1.100): "
    read -r LAN_IP
fi

echo " Detected IP: $LAN_IP"
echo ""

# Write .env so docker-compose passes the real host IP into the container
printf "PUBLIC_URL=http://%s:3000\n" "$LAN_IP" > .env

# Start (or rebuild) the server
echo " Starting FamilyVault..."
docker compose up -d --build

echo ""
echo " FamilyVault is running!"
echo ""
echo "  Admin panel  >  http://$LAN_IP:3001/admin"
echo "  Family app   >  http://$LAN_IP:3000"
echo ""

# Try to open browser on desktop systems (silently skip on headless Pi)
open "http://$LAN_IP:3001/admin" 2>/dev/null \
    || xdg-open "http://$LAN_IP:3001/admin" 2>/dev/null \
    || echo " Open the admin panel link above in your browser."

echo ""
