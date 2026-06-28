#!/bin/sh
set -e

echo ""
echo " FamilyVault — Remote Access Setup"
echo " ----------------------------------"
echo ""
echo " This connects your vault to the internet via a free Cloudflare Tunnel."
echo " You need a free Cloudflare account and a domain name (~$10/year)."
echo ""
echo " Step 1 — Go to: https://one.dash.cloudflare.com"
echo " Step 2 — Networks → Tunnels → Create a tunnel → Cloudflared"
echo " Step 3 — Name it 'familyvault' and click Save"
echo " Step 4 — Click 'Docker' under Install connector"
echo "          Cloudflare shows a command like:"
echo "            docker run cloudflare/cloudflared:latest tunnel ... --token eyJ..."
echo ""
printf " Paste that full command here: "
read -r DOCKER_CMD

# Extract the token — it's always the value after --token
CF_TOKEN=$(echo "$DOCKER_CMD" | sed 's/.*--token[[:space:]]*//' | awk '{print $1}')

if [ -z "$CF_TOKEN" ]; then
    echo ""
    echo " Could not find a token in that command. Make sure you pasted the full docker run line."
    exit 1
fi

echo ""
echo " Token extracted. Starting the Cloudflare connector..."

# Prefer 'docker compose' (V2); fall back to 'docker-compose' (V1)
if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
else
    COMPOSE="docker-compose"
fi

# Preserve existing PUBLIC_URL if set, write token
EXISTING_URL=""
if [ -f .env ]; then
    EXISTING_URL=$(grep "^PUBLIC_URL=" .env 2>/dev/null | cut -d= -f2- || true)
fi
printf "PUBLIC_URL=%s\nCLOUDFLARE_TOKEN=%s\n" "$EXISTING_URL" "$CF_TOKEN" > .env

$COMPOSE --profile tunnel up -d --build

echo ""
echo " -----------------------------------------------------------"
echo " Connector is running. Back in the Cloudflare dashboard:"
echo ""
echo "  - Click 'Next' (connector should now show as connected)"
echo "  - Under 'Public Hostname' / 'Add route' set:"
echo "      Subdomain: vault  (or anything you like, or leave blank for root domain)"
echo "      Domain:    yourdomain.com"
echo "      Path:      (leave empty)"
echo "      Service:   HTTP"
echo "      URL:       vault:3000"
echo "  - Click 'Add route'"
echo " -----------------------------------------------------------"
echo ""
echo " Once saved, your vault is reachable at https://vault.yourdomain.com"
echo " Share that URL with family members in the app."
echo " The admin panel stays local-only at http://localhost:3001/admin"
echo ""
