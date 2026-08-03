import { describe, expect, it } from "vitest";
import { makeId } from "./ids.js";

describe("makeId", () => {
  it("prefixes ids", () => {
    expect(makeId("mis")).toMatch(/^mis_[0-9a-z]+$/);
  });

  it("does not collide across a large batch", () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => makeId("evt")));
    expect(ids.size).toBe(10_000);
  });
});
