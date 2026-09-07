import { describe, expect, it } from "vitest";
import { tokenExpiresSoon } from "./auth";

const tokenWithExpiry = (expiry: number) => `header.${btoa(JSON.stringify({ exp: expiry }))}.signature`;

describe("tokenExpiresSoon", () => {
  const now = Date.UTC(2026, 8, 6, 0, 0, 0);

  it("keeps a token that remains valid beyond the refresh skew", () => {
    expect(tokenExpiresSoon(tokenWithExpiry(now / 1000 + 61), now)).toBe(false);
  });

  it("refreshes an expired, near-expiry, or malformed token", () => {
    expect(tokenExpiresSoon(tokenWithExpiry(now / 1000 + 60), now)).toBe(true);
    expect(tokenExpiresSoon(tokenWithExpiry(now / 1000 - 1), now)).toBe(true);
    expect(tokenExpiresSoon("not-a-jwt", now)).toBe(true);
  });
});
