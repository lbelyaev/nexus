import { describe, it, expect } from "vitest";
import { generateToken, validateToken } from "../auth.js";

describe("generateToken", () => {
  it("returns a 32-character hex string", () => {
    const token = generateToken();
    expect(token).toHaveLength(32);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns different values each call", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });
});

describe("validateToken", () => {
  it("returns true for matching token", () => {
    const token = generateToken();
    expect(validateToken(token, token)).toBe(true);
  });

  it("returns false for wrong token", () => {
    const token = generateToken();
    const other = generateToken();
    expect(validateToken(other, token)).toBe(false);
  });

  it("returns false for empty string", () => {
    const token = generateToken();
    expect(validateToken("", token)).toBe(false);
  });

  it("returns false for null", () => {
    const token = generateToken();
    expect(validateToken(null, token)).toBe(false);
  });

  it("returns false for undefined", () => {
    const token = generateToken();
    expect(validateToken(undefined, token)).toBe(false);
  });
});
