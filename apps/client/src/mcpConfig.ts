export type McpTransport = "streamable-http" | "sse";

export interface McpServerConfig {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  transport: McpTransport;
  authHeaderRef: string;
  enabled: boolean;
  updatedAt: number;
}

export type McpServerInput = Omit<McpServerConfig, "updatedAt">;

export const MCP_CONFIG_STORAGE_KEY = "nkg.integrations.mcp.v1";

export function normalizeMcpServer(input: McpServerInput): McpServerInput {
  const id = input.id.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const name = input.name.trim();
  const description = input.description.trim();
  const authHeaderRef = input.authHeaderRef.trim();
  if (!id || !name) throw new Error("MCP 标识和名称不能为空");
  if (input.transport !== "streamable-http" && input.transport !== "sse") {
    throw new Error("不支持的 MCP 传输类型");
  }
  const url = new URL(input.endpoint.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("MCP 地址必须使用 HTTP 或 HTTPS");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("MCP 地址不能包含凭据或片段");
  }
  return {
    id,
    name,
    description,
    endpoint: url.toString(),
    transport: input.transport,
    authHeaderRef,
    enabled: Boolean(input.enabled),
  };
}

export function loadMcpServers(
  storage: Pick<Storage, "getItem"> = localStorage,
): McpServerConfig[] {
  try {
    const raw = storage.getItem(MCP_CONFIG_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isMcpServerConfig)
      .sort((left, right) => Number(right.enabled) - Number(left.enabled) || right.updatedAt - left.updatedAt);
  } catch {
    return [];
  }
}

export function saveMcpServers(
  servers: McpServerConfig[],
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(MCP_CONFIG_STORAGE_KEY, JSON.stringify(servers));
}

export function upsertMcpServer(
  servers: McpServerConfig[],
  input: McpServerInput,
  now = Date.now(),
): McpServerConfig[] {
  const normalized = normalizeMcpServer(input);
  const next = servers.filter((server) => server.id !== normalized.id);
  next.unshift({ ...normalized, updatedAt: now });
  return next.sort((left, right) => Number(right.enabled) - Number(left.enabled) || right.updatedAt - left.updatedAt);
}

export function removeMcpServer(servers: McpServerConfig[], id: string): McpServerConfig[] {
  return servers.filter((server) => server.id !== id);
}

function isMcpServerConfig(value: unknown): value is McpServerConfig {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<McpServerConfig>;
  return typeof item.id === "string"
    && typeof item.name === "string"
    && typeof item.description === "string"
    && typeof item.endpoint === "string"
    && (item.transport === "streamable-http" || item.transport === "sse")
    && typeof item.authHeaderRef === "string"
    && typeof item.enabled === "boolean"
    && typeof item.updatedAt === "number";
}
