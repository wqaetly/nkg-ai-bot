import { describe, expect, it } from "vitest";
import {
  INSECURE_PROVIDER_WARNING,
  isPlainHttpProviderUrl,
} from "../src/providerSecurity";
import { VaultUnlockError } from "../src/storage/secretVault";

describe("Provider security interaction", () => {
  it.each([
    ["http://127.0.0.1:11434/v1", true],
    ["http://192.168.1.8/v1", true],
    ["https://api.example.com/v1", false],
    ["not-yet-a-url", false],
  ])("classifies %s as plaintext=%s", (url, expected) => {
    expect(isPlainHttpProviderUrl(url)).toBe(expected);
  });

  it("states the concrete data exposed by plaintext transport", () => {
    expect(INSECURE_PROVIDER_WARNING).toContain("API Key");
    expect(INSECURE_PROVIDER_WARNING).toContain("提示词");
    expect(INSECURE_PROVIDER_WARNING).toContain("模型回复");
  });

  it("gives vault failures a stable user-facing code without exposing plugin details", () => {
    const error = new VaultUnlockError();
    expect(error).toMatchObject({ name: "VaultUnlockError", code: "vault.unlock_failed" });
    expect(error.message).toContain("检查密码");
  });
});
