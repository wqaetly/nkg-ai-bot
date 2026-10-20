import { describe, expect, it, vi } from "vitest";
import {
  ScopedCapabilityAuthorizer,
  analyzeFlowCapabilities,
} from "../src/capabilityPolicy";

describe("Flow capability policy", () => {
  it("reports required, unavailable and user-authorized capabilities", () => {
    const report = analyzeFlowCapabilities({
      id: "file_agent",
      version: "1.0.0",
      label: "File Agent",
      nodes: [{
        id: "agent",
        type: "agent",
        config: {
          allowedTools: ["read_file", "write_files", "run_bash"],
          allowBash: true,
        },
      }],
    }, "windows");
    expect(report.required).toEqual([
      "filesystem.read",
      "filesystem.write",
      "network.http",
      "process.spawn",
      "secret.read",
    ]);
    expect(report.authorizationRequired).toEqual(["filesystem.read"]);
    expect(report.unavailable).toEqual(["filesystem.write", "process.spawn"]);
  });

  it("isolates grants by Flow and supports revocation", () => {
    const authorizer = new ScopedCapabilityAuthorizer();
    const listener = vi.fn();
    authorizer.subscribe(listener);
    authorizer.grant("flow-a", ["filesystem.read", "filesystem.write"]);
    expect(authorizer.isAuthorized("flow-a", "filesystem.read")).toBe(true);
    expect(authorizer.isAuthorized("flow-a", "filesystem.write")).toBe(false);
    expect(authorizer.isAuthorized("flow-b", "filesystem.read")).toBe(false);
    authorizer.revoke("flow-a");
    expect(authorizer.isAuthorized("flow-a", "filesystem.read")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it.each(["affiliate_commerce", "public_market_search", "computer_revision_search"])("declares %s as a network and run-secret node", (type) => {
    const report = analyzeFlowCapabilities({
      id: "computer_config_advisor",
      version: "2.0.0",
      nodes: [{ id: "affiliate_products", type, config: {} }],
    }, "android");

    expect(report.required).toEqual(["network.http", "secret.read"]);
    expect(report.unavailable).toEqual([]);
  });
});
