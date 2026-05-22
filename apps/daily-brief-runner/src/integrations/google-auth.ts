// Google OAuth 2.0 helper for the daily-brief runner.
//
// Two modes:
//   1. PKCE flow (`buildPkceAuthUrl` + `exchangePkceCode`) — for first-time
//      installs without a client_secret. Produces an initial refresh token
//      that you persist in GOOGLE_OAUTH_REFRESH_TOKEN.
//   2. Refresh-token grant (`getAccessToken`) — used at runtime. Caches the
//      short-lived access_token to disk so concurrent fetchers reuse it.

import { createHash, randomBytes } from "node:crypto";
import { loadJsonFile, saveJsonFile } from "@hermes-harness-with-missioncontrol/state-store";
import { resolve } from "node:path";

const DEFAULT_TOKEN_FILE = resolve(process.cwd(), "../../data/daily-brief-tokens.json");
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE_DEFAULT = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ");

type TokenCache = Record<string, { access_token: string; expires_at: string }>;

export interface GetAccessTokenOptions {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  cacheKey?: string;
  tokenFile?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export async function getAccessToken(options: GetAccessTokenOptions): Promise<string> {
  const tokenFile = options.tokenFile ?? DEFAULT_TOKEN_FILE;
  const cacheKey = options.cacheKey ?? hashCacheKey(options.clientId, options.refreshToken);
  const now = options.now ? options.now() : new Date();
  const cache = await loadJsonFile<TokenCache>(tokenFile, {});
  const existing = cache[cacheKey];
  if (existing && new Date(existing.expires_at).getTime() - 60_000 > now.getTime()) {
    return existing.access_token;
  }
  const fetchFn = options.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: options.clientId,
    refresh_token: options.refreshToken,
    grant_type: "refresh_token",
  });
  if (options.clientSecret) body.set("client_secret", options.clientSecret);
  const response = await fetchFn(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`google token exchange failed: ${response.status} ${errBody.slice(0, 300)}`);
  }
  const data = (await response.json()) as { access_token: string; expires_in: number };
  const expiresAt = new Date(now.getTime() + (data.expires_in - 30) * 1000).toISOString();
  cache[cacheKey] = { access_token: data.access_token, expires_at: expiresAt };
  await saveJsonFile(tokenFile, cache);
  return data.access_token;
}

export interface PkceChallenge {
  verifier: string;
  challenge: string;
  method: "S256";
}

export function generatePkceChallenge(): PkceChallenge {
  const verifier = randomBytes(64).toString("base64url").slice(0, 96);
  const challenge = createHash("sha256").update(verifier).digest().toString("base64url");
  return { verifier, challenge, method: "S256" };
}

export interface BuildPkceAuthUrlOptions {
  clientId: string;
  redirectUri: string;
  scopes?: string[];
  state?: string;
  pkce: PkceChallenge;
  accessType?: "offline" | "online";
  prompt?: "consent" | "none" | "select_account";
  loginHint?: string;
}

export function buildPkceAuthUrl(options: BuildPkceAuthUrlOptions): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (options.scopes ?? [SCOPE_DEFAULT]).join(" "));
  url.searchParams.set("access_type", options.accessType ?? "offline");
  url.searchParams.set("prompt", options.prompt ?? "consent");
  url.searchParams.set("code_challenge", options.pkce.challenge);
  url.searchParams.set("code_challenge_method", options.pkce.method);
  if (options.state) url.searchParams.set("state", options.state);
  if (options.loginHint) url.searchParams.set("login_hint", options.loginHint);
  return url.toString();
}

export interface ExchangePkceCodeOptions {
  clientId: string;
  redirectUri: string;
  code: string;
  verifier: string;
  fetchImpl?: typeof fetch;
}

export interface PkceTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
  id_token?: string;
}

export async function exchangePkceCode(options: ExchangePkceCodeOptions): Promise<PkceTokenResponse> {
  const fetchFn = options.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: options.clientId,
    code: options.code,
    code_verifier: options.verifier,
    grant_type: "authorization_code",
    redirect_uri: options.redirectUri,
  });
  const response = await fetchFn(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`pkce code exchange failed: ${response.status} ${errBody.slice(0, 300)}`);
  }
  return (await response.json()) as PkceTokenResponse;
}

function hashCacheKey(clientId: string, refreshToken: string) {
  return createHash("sha256").update(`${clientId}|${refreshToken}`).digest("hex").slice(0, 32);
}

export const GOOGLE_OAUTH_TOKEN_URL = GOOGLE_TOKEN_URL;
export const GOOGLE_OAUTH_AUTH_URL = GOOGLE_AUTH_URL;
export const GOOGLE_OAUTH_DEFAULT_SCOPES = SCOPE_DEFAULT;
