// `vite build` inlines every VITE_* variable into the emitted JS as clear
// text. VITE_OPERATOR_TOKEN is the bearer token guarding every mutating API,
// so baking it into a static bundle hands full control-plane access to anyone
// who can fetch the console's assets.
//
// This lives outside vite.config.ts only so it can be unit-tested; nothing in
// the app imports it, so it never reaches the bundle itself.
//
// `env` must be the *resolved* Vite env — `loadEnv(mode, envDir)` — not
// `process.env`. Vite inlines VITE_* variables from the .env files (.env,
// .env.local, .env.[mode], .env.[mode].local) as well as from the process
// environment, so a guard reading only process.env passes a build whose
// bundle still carries the token.
export function assertOperatorTokenNotBundled(
  command: string,
  env: Record<string, string | undefined>,
  allowOverride: string | undefined
): void {
  if (command !== "build") return;
  if (!env.VITE_OPERATOR_TOKEN) return;
  if (allowOverride === "1") return;

  throw new Error(
    "VITE_OPERATOR_TOKEN is set during `vite build`: it would be inlined into the console bundle in clear text. "
    + "Unset it -- in the environment and in any .env file next to the console -- and enter the token in the "
    + "console's Settings tab instead, or set ALLOW_OPERATOR_TOKEN_IN_BUNDLE=1 if you really intend to ship it."
  );
}
