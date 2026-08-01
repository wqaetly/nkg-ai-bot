import { describe, expect, it } from "vitest";
import { normalizeNewApiBaseUrl, parseModels, parsePointPacks } from "../src/config.js";

describe("hosted AI configuration", () => {
  it("normalizes New API roots so the gateway never emits /v1/v1", () => {
    expect(normalizeNewApiBaseUrl("https://new-api.example.test/v1"))
      .toBe("https://new-api.example.test");
    expect(normalizeNewApiBaseUrl("https://new-api.example.test/internal"))
      .toBe("https://new-api.example.test/internal");
  });

  it("rejects duplicate server-owned catalog identifiers", () => {
    const model = {
      id: "nkg-fast",
      name: "NKG Fast",
      contextWindow: 128_000,
      inputPointsPerMillionTokens: 100,
      outputPointsPerMillionTokens: 500,
      reservePoints: 50,
      capabilities: ["text"],
    };
    expect(() => parseModels(JSON.stringify([model, model]))).toThrow(/不能重复/);
    expect(() => parseModels(JSON.stringify([{ ...model, capabilities: ["unknown"] }])))
      .toThrow(/未知 capability/);
    const pack = { id: "points-600", points: 600, appleProductId: "com.nkg.points.600" };
    expect(() => parsePointPacks(JSON.stringify([pack, pack]))).toThrow(/不能重复/);
  });
});
