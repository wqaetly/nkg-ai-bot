import { listFlows, upsertFlow, type StoredFlow } from "./storage/repositories";

export const BUILTIN_CHAT_FLOW_ID = "builtin_chat";
export const BUILTIN_CHAT_FLOW_VERSION = "1.0.0";
export const COMPUTER_CONFIG_FLOW_ID = "computer_config_advisor";
export const COMPUTER_CONFIG_FLOW_VERSION = "2.1.0";
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

/** One complete, inspectable business Flow: plan concrete product queries,
 * parse the bounded plan, call the affiliate adapter node, then generate the
 * professional recommendation. Credentials remain run-scoped variables. */
export const COMPUTER_CONFIG_FLOW = {
  id: COMPUTER_CONFIG_FLOW_ID,
  version: COMPUTER_CONFIG_FLOW_VERSION,
  schemaVersion: "flow.graph.v1",
  label: "专业电脑配置推荐",
  description: "在一个 Flow 内完成商品规划、联盟检索转链、兼容性分析与配置建议",
  nodes: [
    {
      id: "start",
      type: "start",
      typeVersion: "1.0.0",
      position: { x: 0, y: 0 },
      size: { width: 280, height: 112 },
      ports: [
        { id: "out", direction: "output", kind: "control", label: "下一步" },
        { id: "runInput", direction: "output", kind: "data", label: "装机需求" },
      ],
      config: {},
    },
    {
      id: "product_query_planner",
      type: "llm",
      typeVersion: "1.0.0",
      position: { x: 450, y: 0 },
      size: { width: 280, height: 422 },
      ports: [
        { id: "in", direction: "input", kind: "control", label: "输入", multiple: true },
        { id: "out", direction: "output", kind: "control", label: "输出" },
        { id: "prompt", direction: "input", kind: "data", label: "提示词", schema: { type: "string" } },
        { id: "result", direction: "output", kind: "data", label: "查询计划", schema: { type: "string" } },
        { id: "summary", direction: "output", kind: "data", label: "Summary" },
        { id: "error", direction: "output", kind: "error", label: "错误" },
      ],
      config: {
        baseUrl: "$var:LLM_BASE_URL",
        apiKey: "$var:LLM_API_KEY",
        model: "$var:LLM_DEFAULT_MODEL",
        temperature: 0,
        maxTokens: 4096,
        runtimeTimeoutMs: 120000,
        prompt: `你是电脑配置商品查询规划器。根据完整对话判断是否需要查询真实商品，只输出 JSON：
{"queries":[{"keyword":"具体型号与品类","minPrice":1000,"maxPrice":2000,"count":2}]}

规则：缺少关键预算/用途、仅问知识或无需购买时返回 {"queries":[]}；最多 8 条；keyword 必须含明确型号与品类；count 只能是 1 或 2；不得输出链接、解释或凭据。

完整顾问请求：
\${__runInput__}`,
        jsonOutput: true,
        stream: false,
      },
    },
    {
      id: "parse_query_plan",
      type: "parse_json",
      typeVersion: "1.0.0",
      position: { x: 900, y: 0 },
      size: { width: 280, height: 300 },
      ports: [
        { id: "in", direction: "input", kind: "control", label: "解析" },
        { id: "text", direction: "input", kind: "data", label: "JSON 文本" },
        { id: "parsed", direction: "output", kind: "control", label: "有效" },
        { id: "invalid", direction: "output", kind: "control", label: "无效" },
        { id: "value", direction: "output", kind: "data", label: "查询计划" },
        { id: "errorMessage", direction: "output", kind: "data", label: "错误" },
      ],
      config: { trim: true, unwrapCodeFence: true, acceptNonString: true },
    },
    {
      id: "affiliate_products",
      type: "affiliate_commerce",
      typeVersion: "1.0.0",
      position: { x: 1350, y: 0 },
      size: { width: 300, height: 360 },
      ports: [
        { id: "in", direction: "input", kind: "control", label: "执行" },
        { id: "plan", direction: "input", kind: "data", label: "查询计划" },
        { id: "planError", direction: "input", kind: "data", label: "规划错误" },
        { id: "request", direction: "input", kind: "data", label: "原始顾问请求" },
        { id: "out", direction: "output", kind: "control", label: "完成" },
        { id: "advisorInput", direction: "output", kind: "data", label: "顾问模型输入" },
        { id: "queries", direction: "output", kind: "data", label: "商品查询", schema: { type: "array" } },
        { id: "products", direction: "output", kind: "data", label: "推广商品", schema: { type: "array" } },
        { id: "errors", direction: "output", kind: "data", label: "部分失败", schema: { type: "array" } },
        { id: "summary", direction: "output", kind: "data", label: "Summary" },
      ],
      config: { maxQueries: 8, concurrency: 3 },
    },
    {
      id: "chat_model",
      type: "llm",
      typeVersion: "1.0.0",
      position: { x: 1800, y: 0 },
      size: { width: 280, height: 422 },
      ports: [
        { id: "in", direction: "input", kind: "control", label: "输入", multiple: true },
        { id: "out", direction: "output", kind: "control", label: "输出" },
        { id: "prompt", direction: "input", kind: "data", label: "顾问输入" },
        { id: "result", direction: "output", kind: "data", label: "配置建议", schema: { type: "string" } },
        { id: "summary", direction: "output", kind: "data", label: "Summary" },
        { id: "error", direction: "output", kind: "error", label: "错误" },
      ],
      config: {
        baseUrl: "$var:LLM_BASE_URL",
        apiKey: "$var:LLM_API_KEY",
        model: "$var:LLM_DEFAULT_MODEL",
        temperature: 0.25,
        maxTokens: 6144,
        prompt: "",
        stream: true,
      },
    },
    {
      id: "end",
      type: "end",
      typeVersion: "1.0.0",
      position: { x: 2250, y: 0 },
      size: { width: 280, height: 96 },
      ports: [{ id: "in", direction: "input", kind: "control", label: "运行" }],
      config: {},
    },
  ],
  edges: [
    { id: "edge_01", from: { nodeId: "start", portId: "out" }, to: { nodeId: "product_query_planner", portId: "in" } },
    { id: "edge_03", from: { nodeId: "product_query_planner", portId: "out" }, to: { nodeId: "parse_query_plan", portId: "in" } },
    { id: "edge_04", from: { nodeId: "product_query_planner", portId: "result" }, to: { nodeId: "parse_query_plan", portId: "text" } },
    { id: "edge_05", from: { nodeId: "parse_query_plan", portId: "parsed" }, to: { nodeId: "affiliate_products", portId: "in" } },
    { id: "edge_07", from: { nodeId: "parse_query_plan", portId: "value" }, to: { nodeId: "affiliate_products", portId: "plan" } },
    { id: "edge_08", from: { nodeId: "parse_query_plan", portId: "errorMessage" }, to: { nodeId: "affiliate_products", portId: "planError" } },
    { id: "edge_09", from: { nodeId: "start", portId: "runInput" }, to: { nodeId: "affiliate_products", portId: "request" } },
    { id: "edge_10", from: { nodeId: "affiliate_products", portId: "out" }, to: { nodeId: "chat_model", portId: "in" } },
    { id: "edge_11", from: { nodeId: "affiliate_products", portId: "advisorInput" }, to: { nodeId: "chat_model", portId: "prompt" } },
    { id: "edge_12", from: { nodeId: "chat_model", portId: "out" }, to: { nodeId: "end", portId: "in" } },
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
    {
      id: COMPUTER_CONFIG_FLOW_ID,
      version: COMPUTER_CONFIG_FLOW_VERSION,
      name: "专业电脑配置推荐",
      graph: COMPUTER_CONFIG_FLOW,
    },
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
