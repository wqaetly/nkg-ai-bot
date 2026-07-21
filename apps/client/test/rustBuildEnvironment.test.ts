import { describe, expect, it } from "vitest";
import { resolveCargoBuildJobs } from "../../../scripts/rust-env.mjs";

describe("Rust build environment", () => {
  it("uses the machine parallelism when no explicit Cargo job limit is configured", () => {
    expect(resolveCargoBuildJobs(undefined, 24)).toBe("24");
    expect(resolveCargoBuildJobs(undefined, 1)).toBe("1");
  });

  it("preserves an explicit Cargo job override", () => {
    expect(resolveCargoBuildJobs("6", 24)).toBe("6");
  });
});
