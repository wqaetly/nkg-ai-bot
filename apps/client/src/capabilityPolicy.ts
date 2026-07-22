import type { AppPlatform } from "@nkg-ai-bot/runtime-router";

export type ProductCapability =
  | "network.http"
  | "secret.read"
  | "filesystem.read"
  | "filesystem.write"
  | "process.spawn"
  | "lifecycle.checkpoint";

export interface FlowCapabilityNodeIssue {
  nodeId: string;
  nodeType: string;
  required: ProductCapability[];
}

export interface FlowCapabilityReport {
  flowId: string;
  flowVersion: string;
  label: string;
  required: ProductCapability[];
  available: ProductCapability[];
  unavailable: ProductCapability[];
  authorizationRequired: ProductCapability[];
  nodes: FlowCapabilityNodeIssue[];
}

export interface CapabilityGrant {
  flowId: string;
  capabilities: ProductCapability[];
}

const CORE: ProductCapability[] = [
  "network.http",
  "secret.read",
  "lifecycle.checkpoint",
];
const PORTABLE_AVAILABLE = [...CORE, "filesystem.read"] satisfies ProductCapability[];
export const USER_GRANTABLE_CAPABILITIES = ["filesystem.read"] as const;

export function analyzeFlowCapabilities(
  graph: unknown,
  _platform: AppPlatform,
): FlowCapabilityReport {
  const flow = graph as {
    id?: unknown;
    version?: unknown;
    label?: unknown;
    nodes?: Array<{ id?: unknown; type?: unknown; config?: Record<string, unknown> }>;
  };
  const nodes: FlowCapabilityNodeIssue[] = [];
  const required = new Set<ProductCapability>();
  for (const node of flow.nodes ?? []) {
    const nodeRequired = requiredForNode(String(node.type ?? ""), node.config ?? {});
    for (const capability of nodeRequired) required.add(capability);
    if (nodeRequired.length > 0) {
      nodes.push({
        nodeId: String(node.id ?? "unknown"),
        nodeType: String(node.type ?? "unknown"),
        required: nodeRequired,
      });
    }
  }
  const requiredList = [...required].sort();
  const available = [...PORTABLE_AVAILABLE].sort();
  return {
    flowId: String(flow.id ?? "unknown"),
    flowVersion: String(flow.version ?? "unknown"),
    label: typeof flow.label === "string" ? flow.label : String(flow.id ?? "Flow"),
    required: requiredList,
    available,
    unavailable: requiredList.filter((item) => !available.includes(item)),
    authorizationRequired: requiredList.filter((item) =>
      USER_GRANTABLE_CAPABILITIES.includes(item as "filesystem.read")),
    nodes,
  };
}

export class ScopedCapabilityAuthorizer {
  private readonly grants = new Map<string, Set<ProductCapability>>();
  private readonly subscribers = new Set<() => void>();

  isAuthorized(flowId: string, capability: ProductCapability): boolean {
    return this.grants.get(flowId)?.has(capability) ?? false;
  }

  grant(flowId: string, capabilities: readonly ProductCapability[]): void {
    const allowed = capabilities.filter((item) =>
      USER_GRANTABLE_CAPABILITIES.includes(item as "filesystem.read"));
    if (allowed.length === 0) return;
    const scoped = this.grants.get(flowId) ?? new Set<ProductCapability>();
    for (const capability of allowed) scoped.add(capability);
    this.grants.set(flowId, scoped);
    this.notify();
  }

  revoke(flowId: string): void {
    if (this.grants.delete(flowId)) this.notify();
  }

  snapshot(): CapabilityGrant[] {
    return [...this.grants.entries()].map(([flowId, capabilities]) => ({
      flowId,
      capabilities: [...capabilities].sort(),
    }));
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  private notify(): void {
    for (const subscriber of this.subscribers) subscriber();
  }
}

export const capabilityAuthorizer = new ScopedCapabilityAuthorizer();

export function capabilityLabel(capability: ProductCapability): string {
  const labels: Record<ProductCapability, string> = {
    "network.http": "网络访问",
    "secret.read": "读取运行密钥",
    "filesystem.read": "读取应用文件",
    "filesystem.write": "写入文件",
    "process.spawn": "执行本机命令",
    "lifecycle.checkpoint": "后台恢复点",
  };
  return labels[capability];
}

function requiredForNode(
  type: string,
  config: Record<string, unknown>,
): ProductCapability[] {
  const required = new Set<ProductCapability>();
  if (type === "http") required.add("network.http");
  if (type === "affiliate_commerce") {
    required.add("network.http");
    required.add("secret.read");
  }
  if (type === "llm" || type === "agent") {
    required.add("network.http");
    required.add("secret.read");
  }
  if (["checkpoint", "resume_point", "wait_signal", "wait_timer", "signal_resume"].includes(type)) {
    required.add("lifecycle.checkpoint");
  }
  const tools = type === "tool"
    ? (typeof config.tool === "string" ? [config.tool] : [])
    : type === "agent"
      ? (Array.isArray(config.allowedTools)
          ? config.allowedTools.filter((item): item is string => typeof item === "string")
          : ["list_files", "read_file", "grep", "edit_file", "write_files"])
      : [];
  if (tools.some((tool) => ["list_files", "read_file", "grep"].includes(tool))) required.add("filesystem.read");
  if (tools.some((tool) => ["edit_file", "write_files"].includes(tool))) required.add("filesystem.write");
  if (config.allowBash === true || tools.includes("run_bash")) required.add("process.spawn");
  return [...required].sort();
}
