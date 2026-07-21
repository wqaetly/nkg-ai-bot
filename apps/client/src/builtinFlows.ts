import { listFlows, upsertFlow, type StoredFlow } from "./storage/repositories";

export const BUILTIN_CHAT_FLOW_ID = "builtin_chat";
export const BUILTIN_CHAT_FLOW_VERSION = "1.0.0";
export const BUILTIN_REFLECTION_FLOW_ID = "builtin_reflection";
export const BUILTIN_REFLECTION_FLOW_VERSION = "1.0.0";

/**
 * The ordinary chat surface is itself a Flow. Provider-specific values stay
 * as run-scoped variables, so neither the graph nor SQLite ever contains an
 * API key.
 */
export const BUILTIN_CHAT_FLOW = {
  id: BUILTIN_CHAT_FLOW_ID,
  version: BUILTIN_CHAT_FLOW_VERSION,
  schemaVersion: "flow.graph.v1",
  label: "日常聊天",
  description: "本地客户端内置的 OpenAI-compatible 流式聊天 Flow",
  nodes: [
    {
      id: "start",
      type: "start",
      typeVersion: "1.0.0",
      position: { x: 0, y: 0 },
      size: { width: 280, height: 112 },
      ports: [
        { id: "out", direction: "output", kind: "control", label: "下一步" },
        { id: "runInput", direction: "output", kind: "data", label: "运行输入" },
      ],
      config: {},
    },
    {
      id: "chat_model",
      type: "llm",
      typeVersion: "1.0.0",
      position: { x: 450, y: 0 },
      size: { width: 280, height: 422 },
      ports: [
        { id: "in", direction: "input", kind: "control", label: "输入", multiple: true },
        { id: "out", direction: "output", kind: "control", label: "输出" },
        { id: "prompt", direction: "input", kind: "data", label: "提示词", schema: { type: "string" } },
        { id: "result", direction: "output", kind: "data", label: "结果", schema: { type: "string" } },
        { id: "summary", direction: "output", kind: "data", label: "Summary" },
        { id: "error", direction: "output", kind: "error", label: "错误" },
      ],
      config: {
        baseUrl: "$var:LLM_BASE_URL",
        apiKey: "$var:LLM_API_KEY",
        model: "$var:LLM_DEFAULT_MODEL",
        temperature: 0.7,
        maxTokens: 4096,
        prompt: "",
        stream: true,
      },
    },
    {
      id: "end",
      type: "end",
      typeVersion: "1.0.0",
      position: { x: 900, y: 0 },
      size: { width: 280, height: 96 },
      ports: [
        { id: "in", direction: "input", kind: "control", label: "运行" },
      ],
      config: {},
    },
  ],
  edges: [
    { id: "edge_01", from: { nodeId: "start", portId: "out" }, to: { nodeId: "chat_model", portId: "in" } },
    { id: "edge_02", from: { nodeId: "start", portId: "runInput" }, to: { nodeId: "chat_model", portId: "prompt" } },
    { id: "edge_03", from: { nodeId: "chat_model", portId: "out" }, to: { nodeId: "end", portId: "in" } },
  ],
} as const;

/**
 * Produces a small JSON proposal document from bounded local evidence. The
 * graph never writes learning state itself; the client validates its output
 * and stores reviewable candidates after the run succeeds.
 */
export const BUILTIN_REFLECTION_FLOW = {
  id: BUILTIN_REFLECTION_FLOW_ID,
  version: BUILTIN_REFLECTION_FLOW_VERSION,
  schemaVersion: "flow.graph.v1",
  label: "本地学习反思",
  description: "根据用户反馈提出需要人工批准的本地事实记忆候选",
  nodes: [
    {
      id: "start",
      type: "start",
      typeVersion: "1.0.0",
      position: { x: 0, y: 0 },
      size: { width: 280, height: 112 },
      ports: [
        { id: "out", direction: "output", kind: "control", label: "下一步" },
        { id: "runInput", direction: "output", kind: "data", label: "运行输入" },
      ],
      config: {},
    },
    {
      id: "reflection_model",
      type: "llm",
      typeVersion: "1.0.0",
      position: { x: 450, y: 0 },
      size: { width: 280, height: 422 },
      ports: [
        { id: "in", direction: "input", kind: "control", label: "输入", multiple: true },
        { id: "out", direction: "output", kind: "control", label: "输出" },
        { id: "prompt", direction: "input", kind: "data", label: "提示词", schema: { type: "string" } },
        { id: "result", direction: "output", kind: "data", label: "结果", schema: { type: "string" } },
        { id: "summary", direction: "output", kind: "data", label: "Summary" },
        { id: "error", direction: "output", kind: "error", label: "错误" },
      ],
      config: {
        baseUrl: "$var:LLM_BASE_URL",
        apiKey: "$var:LLM_API_KEY",
        model: "$var:LLM_DEFAULT_MODEL",
        temperature: 0,
        maxTokens: 1400,
        prompt: "",
        stream: true,
      },
    },
    {
      id: "end",
      type: "end",
      typeVersion: "1.0.0",
      position: { x: 900, y: 0 },
      size: { width: 280, height: 96 },
      ports: [{ id: "in", direction: "input", kind: "control", label: "运行" }],
      config: {},
    },
  ],
  edges: [
    { id: "edge_01", from: { nodeId: "start", portId: "out" }, to: { nodeId: "reflection_model", portId: "in" } },
    { id: "edge_02", from: { nodeId: "start", portId: "runInput" }, to: { nodeId: "reflection_model", portId: "prompt" } },
    { id: "edge_03", from: { nodeId: "reflection_model", portId: "out" }, to: { nodeId: "end", portId: "in" } },
  ],
} as const;

export interface BuiltinFlowStore {
  list(): Promise<StoredFlow[]>;
  upsert(flow: Pick<StoredFlow, "id" | "version" | "name" | "graph">): Promise<void>;
}

const sqliteFlowStore: BuiltinFlowStore = {
  list: () => listFlows(),
  upsert: (flow) => upsertFlow(flow),
};

/** Seed missing system Flows without overwriting a locally edited graph. */
export async function ensureBuiltinFlows(store: BuiltinFlowStore = sqliteFlowStore): Promise<number> {
  const existing = await store.list();
  const definitions = [
    { id: BUILTIN_CHAT_FLOW_ID, version: BUILTIN_CHAT_FLOW_VERSION, name: "日常聊天", graph: BUILTIN_CHAT_FLOW },
    { id: BUILTIN_REFLECTION_FLOW_ID, version: BUILTIN_REFLECTION_FLOW_VERSION, name: "本地学习反思", graph: BUILTIN_REFLECTION_FLOW },
  ] as const;
  let created = 0;
  for (const definition of definitions) {
    if (existing.some((flow) => flow.id === definition.id && flow.version === definition.version)) continue;
    await store.upsert(definition);
    created += 1;
  }
  return created;
}
