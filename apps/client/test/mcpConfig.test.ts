import { describe, expect, it } from "vitest";
import {
  loadMcpServers,
  MCP_CONFIG_STORAGE_KEY,
  normalizeMcpServer,
  removeMcpServer,
  saveMcpServers,
  upsertMcpServer,
} from "../src/mcpConfig";

const draft = {
  id: " Context Server ",
  name: " Context ",
  description: " remote tools ",
  endpoint: "https://example.com/mcp",
  transport: "streamable-http" as const,
  authHeaderRef: " stronghold:mcp/context ",
  enabled: true,
};

describe("MCP configuration", () => {
  it("normalizes safe HTTP connection metadata", () => {
    expect(normalizeMcpServer(draft)).toEqual({
      id: "context-server",
      name: "Context",
      description: "remote tools",
      endpoint: "https://example.com/mcp",
      transport: "streamable-http",
      authHeaderRef: "stronghold:mcp/context",
      enabled: true,
    });
  });

  it("rejects credentials embedded in an endpoint", () => {
    expect(() => normalizeMcpServer({ ...draft, endpoint: "https://token@example.com/mcp" })).toThrow(/凭据/);
  });

  it("upserts, orders and removes servers", () => {
    const disabled = upsertMcpServer([], { ...draft, id: "off", enabled: false }, 1);
    const enabled = upsertMcpServer(disabled, draft, 2);
    expect(enabled.map((server) => server.id)).toEqual(["context-server", "off"]);
    expect(removeMcpServer(enabled, "off")).toHaveLength(1);
  });

  it("persists and restores valid configuration lists", () => {
    let value = "";
    const server = upsertMcpServer([], draft, 3);
    saveMcpServers(server, { setItem: (key, next) => {
      expect(key).toBe(MCP_CONFIG_STORAGE_KEY);
      value = next;
    } });
    expect(loadMcpServers({ getItem: () => value })).toEqual(server);
  });
});
