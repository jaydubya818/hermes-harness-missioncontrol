// One-shot CLI for the daily-brief-runner.
//   Default:    `pnpm --filter daily-brief-runner run:once`
//                runs a brief now, prints the result, exits.
//   --auth:     prints a PKCE auth URL + verifier so you can mint an initial
//               refresh token without standing up a web server.
//   --exchange <code>: exchanges an auth code for tokens using the provided
//               verifier (--verifier) and prints the refresh_token.

import { loadConfig, runOnce } from "./runner.js";
import { buildPkceAuthUrl, exchangePkceCode, generatePkceChallenge } from "./integrations/google-auth.js";

const args = process.argv.slice(2);

function flag(name: string) {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

if (args.includes("--auth")) {
  const clientId = flag("--client-id") ?? process.env.GOOGLE_OAUTH_CLIENT_ID;
  const redirectUri = flag("--redirect-uri") ?? "http://localhost:5050/oauth/callback";
  if (!clientId) {
    console.error("--auth requires --client-id <id> or GOOGLE_OAUTH_CLIENT_ID");
    process.exit(2);
  }
  const pkce = generatePkceChallenge();
  const url = buildPkceAuthUrl({ clientId, redirectUri, pkce });
  console.log(JSON.stringify({
    open_in_browser: url,
    verifier: pkce.verifier,
    next: `node dist/src/cli.js --exchange <code-from-callback> --verifier ${pkce.verifier} --client-id ${clientId} --redirect-uri ${redirectUri}`,
  }, null, 2));
  process.exit(0);
}

if (args.includes("--exchange")) {
  const clientId = flag("--client-id") ?? process.env.GOOGLE_OAUTH_CLIENT_ID;
  const redirectUri = flag("--redirect-uri") ?? "http://localhost:5050/oauth/callback";
  const code = flag("--exchange");
  const verifier = flag("--verifier");
  if (!clientId || !code || !verifier) {
    console.error("--exchange requires --exchange <code> --verifier <verifier> --client-id <id> [--redirect-uri <uri>]");
    process.exit(2);
  }
  const tokens = await exchangePkceCode({ clientId, redirectUri, code, verifier });
  console.log(JSON.stringify({
    refresh_token: tokens.refresh_token,
    access_token_preview: tokens.access_token.slice(0, 12) + "...",
    expires_in: tokens.expires_in,
    note: tokens.refresh_token
      ? "Save refresh_token as GOOGLE_OAUTH_REFRESH_TOKEN in .env"
      : "Google did not return a refresh_token. Re-run --auth with prompt=consent (default) and access_type=offline (default).",
  }, null, 2));
  process.exit(0);
}

const config = loadConfig();
const result = await runOnce(config);
console.log(JSON.stringify({ delivery: result.delivery, warnings: result.brief.warnings }, null, 2));
process.exit(result.delivery.ok ? 0 : 1);
