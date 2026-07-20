import { describe, expect, it, vi } from "vitest";
import { RuntimeCatalogHydrator } from "../src/runtimeCatalogHydrator";
import type { RuntimeCatalogSyncResult } from "../src/runtimeCatalog";

const EMPTY: RuntimeCatalogSyncResult = { total: 0, registered: 0, failures: [] };
const ONE: RuntimeCatalogSyncResult = { total: 1, registered: 1, failures: [] };

describe("RuntimeCatalogHydrator", () => {
  it("hydrates exactly once when a replacement backend generation becomes ready", async () => {
    let generation = 1;
    const runtime = {
      get snapshot() { return { generation }; },
      start: vi.fn(async () => undefined),
    };
    const hydrate = vi.fn(async () => ONE);
    const coordinator = new RuntimeCatalogHydrator(runtime, hydrate, EMPTY);

    await expect(coordinator.ensureCurrent()).resolves.toBe(EMPTY);
    generation = 2;
    const [first, second] = await Promise.all([
      coordinator.ensureCurrent(),
      coordinator.ensureCurrent(),
    ]);

    expect(first).toBe(ONE);
    expect(second).toBe(ONE);
    expect(hydrate).toHaveBeenCalledOnce();
    await coordinator.ensureCurrent();
    expect(hydrate).toHaveBeenCalledOnce();
  });

  it("retries catalog hydration when the backend changes during registration", async () => {
    let generation = 1;
    const runtime = {
      get snapshot() { return { generation }; },
      start: vi.fn(async () => undefined),
    };
    const hydrate = vi.fn(async () => {
      if (hydrate.mock.calls.length === 1) generation = 2;
      return ONE;
    });
    const coordinator = new RuntimeCatalogHydrator(runtime, hydrate, EMPTY);

    await coordinator.refresh();

    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(coordinator.catalog).toBe(ONE);
  });
});
