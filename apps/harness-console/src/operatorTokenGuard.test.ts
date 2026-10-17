import { describe, expect, it } from "vitest";
import { assertOperatorTokenNotBundled } from "./operatorTokenGuard.js";

describe("assertOperatorTokenNotBundled", () => {
  it("lets the dev server run with the token set", () => {
    expect(() => assertOperatorTokenNotBundled("serve", { VITE_OPERATOR_TOKEN: "dev-secret" }, undefined)).not.toThrow();
  });

  it("blocks a build when the token comes from the process environment", () => {
    expect(() => assertOperatorTokenNotBundled("build", { VITE_OPERATOR_TOKEN: "dev-secret" }, undefined))
      .toThrow(/VITE_OPERATOR_TOKEN is set during `vite build`/);
  });

  // The regression: the guard used to read process.env directly, so a token
  // supplied through a .env file -- which Vite still inlines -- built clean
  // and shipped the bearer token in the bundle in clear text. The config now
  // passes loadEnv()'s resolved record, which covers both sources.
  it("blocks a build when the token comes from a .env file rather than the process environment", () => {
    const resolvedFromDotEnvFile = { VITE_OPERATOR_TOKEN: "from-dotenv-file" };
    expect(process.env.VITE_OPERATOR_TOKEN).toBeUndefined();
    expect(() => assertOperatorTokenNotBundled("build", resolvedFromDotEnvFile, undefined))
      .toThrow(/VITE_OPERATOR_TOKEN is set during `vite build`/);
  });

  it("honours the explicit ALLOW_OPERATOR_TOKEN_IN_BUNDLE=1 override", () => {
    expect(() => assertOperatorTokenNotBundled("build", { VITE_OPERATOR_TOKEN: "dev-secret" }, "1")).not.toThrow();
  });

  it("does not treat a non-'1' override value as permission", () => {
    expect(() => assertOperatorTokenNotBundled("build", { VITE_OPERATOR_TOKEN: "dev-secret" }, "true"))
      .toThrow(/VITE_OPERATOR_TOKEN is set during `vite build`/);
  });

  it("allows a build with no token and treats a blank token as absent", () => {
    expect(() => assertOperatorTokenNotBundled("build", {}, undefined)).not.toThrow();
    expect(() => assertOperatorTokenNotBundled("build", { VITE_OPERATOR_TOKEN: "" }, undefined)).not.toThrow();
  });
});
