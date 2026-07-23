import { describe, expect, it } from "vitest";
import { isValidPairingCode } from "../src/lanSync";

describe("LAN sync pairing", () => {
  it("accepts exactly six decimal digits", () => {
    expect(isValidPairingCode("000042")).toBe(true);
    expect(isValidPairingCode("123456")).toBe(true);
    expect(isValidPairingCode("12345")).toBe(false);
    expect(isValidPairingCode("12a456")).toBe(false);
  });
});
