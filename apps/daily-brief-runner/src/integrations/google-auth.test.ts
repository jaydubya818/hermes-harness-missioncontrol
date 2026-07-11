import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPkceAuthUrl, exchangePkceCode, generatePkceChallenge, getAccessToken } from "./google-auth.js";

let workdir: string | null = null;

afterEach(async () => {
  if (workdir) {
    await rm(workdir, { recursive: true, force: true });
    workdir = null;
  }
});

async function freshWorkdir() {
  workdir = await mkdtemp(join(tmpdir(), "daily-brief-auth-"));
  return workdir;
}

describe("google-auth", () => {
  it("PKCE challenge is base64url-safe with S256 method and a verifier between 43 and 128 chars", () => {
    const challenge = generatePkceChallenge();
    expect(challenge.method).toBe("S256");
    expect(challenge.verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge.verifier.length).toBeLessThanOrEqual(128);
    expect(challenge.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("buildPkceAuthUrl includes required Google OAuth params", () => {
    const pkce = generatePkceChallenge();
    const url = new URL(buildPkceAuthUrl({
      clientId: "client-123",
      redirectUri: "http://localhost:5050/oauth/callback",
      pkce,
      state: "state-xyz",
    }));
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:5050/oauth/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe("state-xyz");
  });

  it("exchangePkceCode posts code + verifier and returns tokens", async () => {
    const captured: { body: string; url: string } = { body: "", url: "" };
    const fakeFetch: typeof fetch = (async (input: any, init: any) => {
      captured.url = String(input);
      captured.body = String((init as RequestInit).body);
      return {
        ok: true,
        async json() {
          return { access_token: "acc_1", refresh_token: "ref_1", expires_in: 3600, token_type: "Bearer", scope: "calendar" };
        },
      } as Response;
    }) as any;
    const tokens = await exchangePkceCode({
      clientId: "client-123",
      redirectUri: "http://localhost:5050/oauth/callback",
      code: "code-abc",
      verifier: "verifier-xyz",
      fetchImpl: fakeFetch,
    });
    expect(tokens.access_token).toBe("acc_1");
    expect(tokens.refresh_token).toBe("ref_1");
    expect(captured.url).toContain("oauth2.googleapis.com/token");
    expect(captured.body).toContain("code=code-abc");
    expect(captured.body).toContain("code_verifier=verifier-xyz");
    expect(captured.body).toContain("grant_type=authorization_code");
  });

  it("getAccessToken caches access tokens on disk and reuses them until expiry", async () => {
    const dir = await freshWorkdir();
    const tokenFile = join(dir, "tokens.json");
    let fetchCalls = 0;
    const fakeFetch: typeof fetch = (async () => {
      fetchCalls += 1;
      return {
        ok: true,
        async json() {
          return { access_token: `acc_${fetchCalls}`, expires_in: 3600 };
        },
      } as Response;
    }) as any;
    const now = new Date("2026-05-22T10:00:00Z");
    const first = await getAccessToken({
      clientId: "client-123",
      refreshToken: "ref",
      tokenFile,
      fetchImpl: fakeFetch,
      now: () => now,
    });
    const second = await getAccessToken({
      clientId: "client-123",
      refreshToken: "ref",
      tokenFile,
      fetchImpl: fakeFetch,
      now: () => new Date(now.getTime() + 60_000),
    });
    expect(first).toBe("acc_1");
    expect(second).toBe("acc_1");
    expect(fetchCalls).toBe(1);

    const later = await getAccessToken({
      clientId: "client-123",
      refreshToken: "ref",
      tokenFile,
      fetchImpl: fakeFetch,
      now: () => new Date(now.getTime() + 4 * 60 * 60 * 1000),
    });
    expect(later).toBe("acc_2");
    expect(fetchCalls).toBe(2);
  });
});
