#!/usr/bin/env bash
# Run after successful xAI Grok OAuth login.
set -euo pipefail

echo "→ Enabling x_search and video_gen on CLI..."
hermes tools enable x_search video_gen --platform cli

echo "→ Verifying auth..."
hermes doctor 2>&1 | rg -A1 "xAI OAuth" || true

echo "→ Tool status:"
hermes tools list 2>&1 | rg -i "x_search|video_gen" || true

echo ""
echo "Done. Optional next step for X posting (run yourself, not in agent chat):"
echo "  xurl auth oauth2"
