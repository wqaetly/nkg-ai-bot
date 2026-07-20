import { describe, expect, it, vi } from "vitest";
import { syncRuntimeCatalog } from "../src/runtimeCatalog";
import type { StoredFlow } from "../src/storage/repositories";

function storedFlow(id: string, version = "1.0.0"): StoredFlow {
  return {
    id,
    version,
    name: `Flow ${id}`,
    graph: { id, version, nodes: [], edges: [] },
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("syncRuntimeCatalog", () => {
  it("registers every locally stored Flow through the common runtime client", async () => {
    const flows = [storedFlow("chat"), storedFlow("assistant", "2.0.0")];
    const registerFlow = vi.fn().mockResolvedValue(undefined);

    const result = await syncRuntimeCatalog(
      { registerFlow },
      async () => flows,
    );

    expect(registerFlow).toHaveBeenNthCalledWith(1, flows[0]?.graph);
    expect(registerFlow).toHaveBeenNthCalledWith(2, flows[1]?.graph);
    expect(result).toEqual({ total: 2, registered: 2, failures: [] });
  });

  it("continues registering valid Flows and reports a degraded catalog", async () => {
    const flows = [storedFlow("broken"), storedFlow("healthy")];
    const registerFlow = vi.fn()
      .mockRejectedValueOnce(new Error("invalid node type"))
      .mockResolvedValueOnce(undefined);

    const result = await syncRuntimeCatalog(
      { registerFlow },
      async () => flows,
    );

    expect(registerFlow).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      total: 2,
      registered: 1,
      failures: [{
        id: "broken",
        version: "1.0.0",
        name: "Flow broken",
        message: "invalid node type",
      }],
    });
  });

  it("treats an unreadable local catalog as a startup failure", async () => {
    await expect(syncRuntimeCatalog(
      { registerFlow: vi.fn() },
      async () => { throw new Error("database unavailable"); },
    )).rejects.toThrow("database unavailable");
  });
});
