import { describe, expect, it } from "vitest";
import { makeId } from "./ids.js";

describe("makeId", () => {
  it("prefixes ids", () => {
    expect(makeId("mis")).toMatch(/^mis_/);
  });
});
