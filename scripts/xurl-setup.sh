#!/usr/bin/env bash
# One-time xurl (X API) setup for Hermes.
# Uses port 8081 to avoid conflict with LobsterBoard on 8080.
set -euo pipefail

XURL_APP_NAME="${XURL_APP_NAME:-hermes-agent}"
REDIRECT_URI="${REDIRECT_URI:-http://localhost:8081/callback}"

if ! command -v xurl >/dev/null 2>&1; then
  echo "Installing xurl..."
  curl -fsSL https://raw.githubusercontent.com/xdevplatform/xurl/main/install.sh | bash
fi

if [[ -z "${X_CLIENT_ID:-}" || -z "${X_CLIENT_SECRET:-}" ]]; then
  cat <<EOF
Missing X Developer credentials.

1. Open https://developer.x.com/en/portal/dashboard
2. Create or open an app → User authentication settings
3. Set OAuth 2.0 redirect URI to: ${REDIRECT_URI}
4. Enable scopes: tweet.read, tweet.write, users.read, offline.access (minimum for posting)
5. Move app to Pay-per-use → Production (required for /2/* API)
6. Re-run with credentials (do NOT paste into chat):

   export X_CLIENT_ID='your-client-id'
   export X_CLIENT_SECRET='your-client-secret'
   export X_USERNAME='your_x_handle'   # optional but recommended
   bash scripts/xurl-setup.sh

EOF
  open "https://developer.x.com/en/portal/dashboard" 2>/dev/null || true
  exit 1
fi

echo "→ Registering app '${XURL_APP_NAME}' (redirect: ${REDIRECT_URI})"
xurl auth apps add "${XURL_APP_NAME}" \
  --client-id "${X_CLIENT_ID}" \
  --client-secret "${X_CLIENT_SECRET}" \
  --redirect-uri "${REDIRECT_URI}"

echo "→ Starting OAuth (browser opens; listener on 8081)..."
export REDIRECT_URI
if [[ -n "${X_USERNAME:-}" ]]; then
  xurl auth oauth2 --app "${XURL_APP_NAME}" "${X_USERNAME}"
else
  xurl auth oauth2 --app "${XURL_APP_NAME}"
fi

xurl auth default "${XURL_APP_NAME}" ${X_USERNAME:+"${X_USERNAME}"}

echo "→ Verifying..."
xurl auth status
xurl whoami

echo "✓ xurl ready. Hermes can use the xurl skill for posting/search via official X API."
