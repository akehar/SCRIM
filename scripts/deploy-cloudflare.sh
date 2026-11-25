#!/usr/bin/env bash
# One-shot Scrim → Cloudflare migration. Run from anywhere:
#   ./scripts/deploy-cloudflare.sh
# It signs you into Cloudflare (browser), deploys the worker, then walks
# through each secret: paste the value from the Render dashboard
# (dashboard.render.com → scrim-backend → Environment). Input is hidden.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "— Scrim → Cloudflare —"
echo
echo "[0/3] Installing packages (first run takes a minute)…"
npm install --no-audit --no-fund

echo
echo "[1/3] Signing in (your browser will open; free account is fine)…"
npx wrangler login

echo
echo "[2/3] Deploying the worker + web app…"
npx wrangler deploy

echo
echo "[3/3] Secrets. For each one, paste the value from the Render dashboard"
echo "      and press Enter — typing is hidden. Press Enter alone to skip."
for s in GEMINI_API_KEY ACCESS_CODE CLERK_SECRET_KEY CLERK_PUBLISHABLE_KEY ADMIN_EMAILS; do
  printf "  %s: " "$s"
  IFS= read -rs v
  echo
  if [ -n "$v" ]; then
    printf '%s' "$v" | npx wrangler secret put "$s"
  else
    echo "  (skipped)"
  fi
done

echo
echo "Done. Open your worker URL from the deploy output above and check:"
echo "  https://scrim.<your-subdomain>.workers.dev/health   → expect \"gemini\":true"
echo "Then load the app itself and take a read."
echo
echo "Remember: add the workers.dev domain in Clerk (Configure → Domains)"
echo "so sign-in works on the new URL."
