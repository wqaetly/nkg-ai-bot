import { listFlows, type StoredFlow } from "./storage/repositories";

export interface RuntimeCatalogClient {
  registerFlow(graph: unknown, signal?: AbortSignal): Promise<void>;
}

export interface RuntimeCatalogFailure {
  id: string;
  version: string;
  name: string;
  message: string;
}

export interface RuntimeCatalogSyncResult {
  total: number;
  registered: number;
  failures: RuntimeCatalogFailure[];
}

export type LoadStoredFlows = () => Promise<StoredFlow[]>;

/**
 * Rehydrates the platform runtime from the local Flow catalog.
 *
 * A malformed Flow must not prevent valid local Flows from becoming usable,
 * so registration failures are reported as a degraded result after every
 * record has been attempted. Failure to read the catalog itself remains a
 * startup error because the runtime cannot know which local state is current.
 */
export async function syncRuntimeCatalog(
  client: RuntimeCatalogClient,
  loadFlows: LoadStoredFlows = listFlows,
): Promise<RuntimeCatalogSyncResult> {
  const flows = await loadFlows();
  const failures: RuntimeCatalogFailure[] = [];

  for (const flow of flows) {
    try {
      await client.registerFlow(flow.graph);
    } catch (error: unknown) {
      failures.push({
        id: flow.id,
        version: flow.version,
        name: flow.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    total: flows.length,
    registered: flows.length - failures.length,
    failures,
  };
}
