import { listFlows, upsertFlow, type StoredFlow } from "./storage/repositories";
import { FLOW_MAX_OUTPUT_TOKENS_VARIABLE } from "./conversationFlowConfig";

export const BUILTIN_CHAT_FLOW_ID = "builtin_chat";
export const BUILTIN_CHAT_FLOW_VERSION = "1.0.2";
export const BUILTIN_WEB_SEARCH_PLANNER_FLOW_ID = "builtin_web_search_planner";
export const BUILTIN_WEB_SEARCH_PLANNER_FLOW_VERSION = "1.0.0";
export const COMPUTER_CONFIG_FLOW_ID = "computer_config_advisor";
export const COMPUTER_CONFIG_FLOW_VERSION = "4.7.2";
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
  configurableVariables: [maxOutputTokensConfiguration(4096)],
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
        maxTokensVariable: `$var:${FLOW_MAX_OUTPUT_TOKENS_VARIABLE}`,
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

/** Produces a small, validated query plan before SearXNG is called. */
export const BUILTIN_WEB_SEARCH_PLANNER_FLOW = {
  id: BUILTIN_WEB_SEARCH_PLANNER_FLOW_ID,
  version: BUILTIN_WEB_SEARCH_PLANNER_FLOW_VERSION,
  schemaVersion: "flow.graph.v1",
  label: "联网搜索词规划",
  description: "结合近期对话判断是否需要联网，并生成少量独立搜索关键词",
  nodes: [
    {
      id: "start",
      type: "start",
      typeVersion: "1.0.0",
      position: { x: 0, y: 0 },
      size: { width: 280, height: 112 },
      ports: [
        { id: "out", direction: "output", kind: "control", label: "下一步" },
        { id: "runInput", direction: "output", kind: "data", label: "规划请求" },
      ],
      config: {},
    },
    {
      id: "search_query_planner",
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
        maxTokens: 500,
        runtimeTimeoutMs: 45000,
        prompt: "",
        stream: false,
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
    { id: "edge_01", from: { nodeId: "start", portId: "out" }, to: { nodeId: "search_query_planner", portId: "in" } },
    { id: "edge_02", from: { nodeId: "start", portId: "runInput" }, to: { nodeId: "search_query_planner", portId: "prompt" } },
    { id: "edge_03", from: { nodeId: "search_query_planner", portId: "out" }, to: { nodeId: "end", portId: "in" } },
  ],
} as const;

const computerLlmPorts = [
  { id: "in", direction: "input", kind: "control", label: "输入", multiple: true },
  { id: "out", direction: "output", kind: "control", label: "输出" },
  { id: "prompt", direction: "input", kind: "data", label: "提示词" },
  { id: "result", direction: "output", kind: "data", label: "结果", schema: { type: "string" } },
  { id: "summary", direction: "output", kind: "data", label: "Summary" },
  { id: "error", direction: "output", kind: "error", label: "错误" },
] as const;

const browserCommercePorts = [
  { id: "in", direction: "input", kind: "control", label: "执行" },
  { id: "plan", direction: "input", kind: "data", label: "查询计划" },
  { id: "request", direction: "input", kind: "data", label: "原始顾问请求" },
  { id: "out", direction: "output", kind: "control", label: "完成" },
  { id: "queries", direction: "output", kind: "data", label: "商品查询", schema: { type: "array" } },
  { id: "products", direction: "output", kind: "data", label: "商城商品", schema: { type: "array" } },
  { id: "errors", direction: "output", kind: "data", label: "部分失败", schema: { type: "array" } },
  { id: "telemetry", direction: "output", kind: "data", label: "检索遥测", schema: { type: "array" } },
  { id: "summary", direction: "output", kind: "data", label: "Summary" },
] as const;

const productLinkPorts = [
  { id: "in", direction: "input", kind: "control", label: "解析链接" },
  { id: "out", direction: "output", kind: "control", label: "完成" },
  { id: "selection", direction: "input", kind: "data", label: "最终选择" },
  { id: "products", direction: "output", kind: "data", label: "可展示商品", schema: { type: "array" } },
  { id: "state", direction: "output", kind: "data", label: "链接核验状态" },
  { id: "errors", direction: "output", kind: "data", label: "链接错误", schema: { type: "array" } },
  { id: "summary", direction: "output", kind: "data", label: "Summary" },
  { id: "error", direction: "output", kind: "error", label: "错误" },
] as const;

function computerLlmNode(
  id: string,
  position: { x: number; y: number },
  options: {
    maxTokens: number;
    temperature: number;
    stream?: boolean;
    jsonOutput?: boolean;
    userConfigurableMaxTokens?: boolean;
  },
) {
  return {
    id,
    type: "llm",
    typeVersion: "1.0.0",
    position,
    size: { width: 280, height: 422 },
    ports: computerLlmPorts,
    config: {
      baseUrl: "$var:LLM_BASE_URL",
      apiKey: "$var:LLM_API_KEY",
      model: "$var:LLM_DEFAULT_MODEL",
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      ...(options.userConfigurableMaxTokens
        ? { maxTokensVariable: `$var:${FLOW_MAX_OUTPUT_TOKENS_VARIABLE}` }
        : {}),
      runtimeTimeoutMs: 120000,
      prompt: "",
      stream: options.stream ?? false,
      ...(options.jsonOutput ? { jsonOutput: true } : {}),
      ...(options.jsonOutput
        ? {
          reasoningEffort: "$var:LLM_STRUCTURED_REASONING_EFFORT",
          thinkingMode: "$var:LLM_STRUCTURED_THINKING_MODE",
        }
        : {}),
    },
  };
}

const mergePorts = [
  { id: "in", direction: "input", kind: "control", label: "任一路径", multiple: true },
  { id: "value", direction: "input", kind: "data", label: "路径数据", multiple: true },
  { id: "out", direction: "output", kind: "control", label: "继续" },
  { id: "value", direction: "output", kind: "data", label: "当前数据" },
  { id: "values", direction: "output", kind: "data", label: "全部数据" },
  { id: "count", direction: "output", kind: "data", label: "数量" },
  { id: "summary", direction: "output", kind: "data", label: "Summary" },
] as const;

const requirementPolicyV2Ports = [
  { id: "in", direction: "input", kind: "control", label: "规格化" },
  { id: "draft", direction: "input", kind: "data", label: "需求草案" },
  { id: "request", direction: "input", kind: "data", label: "原始请求" },
  { id: "needsBlueprint", direction: "output", kind: "control", label: "生成蓝图" },
  { id: "needsDirect", direction: "output", kind: "control", label: "直接回答" },
  { id: "requirements", direction: "output", kind: "data", label: "需求规格" },
  { id: "blueprintPrompt", direction: "output", kind: "data", label: "蓝图输入" },
  { id: "directPrompt", direction: "output", kind: "data", label: "直接回答输入" },
  { id: "directFallback", direction: "output", kind: "data", label: "直接回答降级" },
  { id: "summary", direction: "output", kind: "data", label: "Summary" },
] as const;

const blueprintGuardPorts = [
  { id: "in", direction: "input", kind: "control", label: "校验" },
  { id: "draft", direction: "input", kind: "data", label: "蓝图草案" },
  { id: "requirements", direction: "input", kind: "data", label: "需求规格" },
  { id: "request", direction: "input", kind: "data", label: "原始请求" },
  { id: "needsCommerce", direction: "output", kind: "control", label: "实时商品增强" },
  { id: "reportReady", direction: "output", kind: "control", label: "直接组装报告" },
  { id: "requirements", direction: "output", kind: "data", label: "需求规格" },
  { id: "blueprint", direction: "output", kind: "data", label: "完整技术蓝图" },
  { id: "state", direction: "output", kind: "data", label: "覆盖率状态" },
  { id: "summary", direction: "output", kind: "data", label: "Summary" },
] as const;

const querySchedulerPorts = [
  { id: "in", direction: "input", kind: "control", label: "调度" },
  { id: "blueprint", direction: "input", kind: "data", label: "技术蓝图" },
  { id: "state", direction: "input", kind: "data", label: "当前状态" },
  { id: "out", direction: "output", kind: "control", label: "执行查询" },
  { id: "queryPlan", direction: "output", kind: "data", label: "无价格查询计划" },
  { id: "state", direction: "output", kind: "data", label: "调度后状态" },
  { id: "summary", direction: "output", kind: "data", label: "Summary" },
] as const;

const optimizerV2Ports = [
  { id: "in", direction: "input", kind: "control", label: "优化" },
  { id: "requirements", direction: "input", kind: "data", label: "需求规格" },
  { id: "blueprint", direction: "input", kind: "data", label: "技术蓝图" },
  { id: "queries", direction: "input", kind: "data", label: "本波查询" },
  { id: "products", direction: "input", kind: "data", label: "本波商品" },
  { id: "telemetry", direction: "input", kind: "data", label: "检索遥测" },
  { id: "errors", direction: "input", kind: "data", label: "商品错误" },
  { id: "previousState", direction: "input", kind: "data", label: "上一状态" },
  { id: "repair", direction: "output", kind: "control", label: "继续公平调度" },
  { id: "complete", direction: "output", kind: "control", label: "进入商品清单" },
  { id: "state", direction: "output", kind: "data", label: "优化状态" },
  { id: "shortlist", direction: "output", kind: "data", label: "商品候选" },
  { id: "selection", direction: "output", kind: "data", label: "最终状态与商品候选" },
  { id: "summary", direction: "output", kind: "data", label: "Summary" },
] as const;

const reportAssemblerPorts = [
  { id: "in", direction: "input", kind: "control", label: "组装" },
  { id: "requirements", direction: "input", kind: "data", label: "需求规格" },
  { id: "blueprint", direction: "input", kind: "data", label: "技术蓝图" },
  { id: "state", direction: "input", kind: "data", label: "最终状态" },
  { id: "products", direction: "input", kind: "data", label: "已核验商品" },
  { id: "out", direction: "output", kind: "control", label: "完成" },
  { id: "report", direction: "output", kind: "data", label: "确定性报告" },
  { id: "polishPrompt", direction: "output", kind: "data", label: "受限润色输入" },
  { id: "summary", direction: "output", kind: "data", label: "Summary" },
] as const;



const reportGuardPorts = [
  { id: "in", direction: "input", kind: "control", label: "校验" },
  { id: "report", direction: "input", kind: "data", label: "确定性基线" },
  { id: "candidate", direction: "input", kind: "data", label: "候选正文" },
  { id: "polishError", direction: "input", kind: "data", label: "润色失败" },
  { id: "out", direction: "output", kind: "control", label: "输出" },
  { id: "answer", direction: "output", kind: "data", label: "最终回答" },
  { id: "summary", direction: "output", kind: "data", label: "Summary" },
] as const;

const commerceLoopBeginPorts = [
  { id: "in", direction: "input", kind: "control", label: "进入循环" },
  { id: "body", direction: "output", kind: "control", label: "循环体" },
  { id: "initialState", direction: "input", kind: "data", label: "初始状态" },
  { id: "state", direction: "output", kind: "data", label: "当前状态" },
  { id: "iteration", direction: "output", kind: "data", label: "轮次" },
] as const;

const commerceLoopEndPorts = [
  { id: "body_done", direction: "input", kind: "control", label: "本轮完成" },
  { id: "nextState", direction: "input", kind: "data", label: "下一状态" },
  { id: "done", direction: "output", kind: "control", label: "完成" },
  { id: "maxed", direction: "output", kind: "control", label: "达到上限" },
  { id: "timeout", direction: "output", kind: "control", label: "超时" },
  { id: "error", direction: "output", kind: "control", label: "循环错误" },
  { id: "finalState", direction: "output", kind: "data", label: "最终状态" },
  { id: "status", direction: "output", kind: "data", label: "状态" },
  { id: "iterationCount", direction: "output", kind: "data", label: "循环次数" },
] as const;

/** Plan from web context, price concrete models silently, rebalance the budget, then render verified rows. */
export const COMPUTER_CONFIG_FLOW = {
  id: COMPUTER_CONFIG_FLOW_ID,
  version: COMPUTER_CONFIG_FLOW_VERSION,
  schemaVersion: "flow.graph.v1",
  label: "专业电脑配置推荐",
  description: "联网规划型号，后台核价，按总预算迭代升降配置，输出商品价格与直链清单",
  configurableVariables: [maxOutputTokensConfiguration(6144), {
    name: "COMPUTER_SHOPPING_PLATFORM", label: "商品平台", type: "select",
    description: "在所选商城直接搜索商品。首次使用请打开商城窗口完成登录。", defaultValue: "pdd",
    options: [{ label: "拼多多", value: "pdd" }, { label: "京东", value: "jd" }, { label: "淘宝", value: "taobao" }],
  }],
  nodes: [
    {
      id: "start",
      type: "start",
      typeVersion: "1.0.0",
      position: { x: 0, y: 0 },
      size: { width: 280, height: 112 },
      ports: [
        { id: "out", direction: "output", kind: "control", label: "下一步" },
        { id: "runInput", direction: "output", kind: "data", label: "顾问请求" },
      ],
      config: {},
    },
    {
      id: "advisor_context",
      type: "computer_advisor_context",
      typeVersion: "1.0.0",
      position: { x: 360, y: 0 },
      size: { width: 300, height: 240 },
      ports: [
        { id: "in", direction: "input", kind: "control", label: "开始" },
        { id: "request", direction: "input", kind: "data", label: "顾问请求" },
        { id: "out", direction: "output", kind: "control", label: "继续" },
        { id: "requirementPrompt", direction: "output", kind: "data", label: "需求规划输入" },
        { id: "summary", direction: "output", kind: "data", label: "Summary" },
      ],
      config: {},
    },
    computerLlmNode("requirement_planner", { x: 720, y: 0 }, { maxTokens: 2200, temperature: 0, jsonOutput: true }),
    {
      id: "requirement_draft_merge",
      type: "merge",
      typeVersion: "1.0.0",
      position: { x: 1080, y: 0 },
      size: { width: 280, height: 220 },
      ports: mergePorts,
      config: {},
    },
    {
      id: "requirement_policy_v2",
      type: "computer_requirement_policy_v2",
      typeVersion: "1.0.0",
      position: { x: 1440, y: 0 },
      size: { width: 320, height: 400 },
      ports: requirementPolicyV2Ports,
      config: {},
    },
    computerLlmNode("blueprint_planner", { x: 1800, y: 0 }, { maxTokens: 4096, temperature: 0, jsonOutput: true }),
    {
      id: "blueprint_draft_merge",
      type: "merge",
      typeVersion: "1.0.0",
      position: { x: 2160, y: 0 },
      size: { width: 280, height: 220 },
      ports: mergePorts,
      config: {},
    },
    {
      id: "blueprint_guard",
      type: "computer_blueprint_guard",
      typeVersion: "1.0.0",
      position: { x: 2520, y: 0 },
      size: { width: 320, height: 420 },
      ports: blueprintGuardPorts,
      config: {},
    },
    computerLlmNode("direct_model", { x: 1800, y: -560 }, { maxTokens: 4096, temperature: 0.2, stream: false, userConfigurableMaxTokens: true }),
    {
      id: "direct_failure_guard",
      type: "computer_report_guard",
      typeVersion: "1.0.0",
      position: { x: 2160, y: -560 },
      size: { width: 300, height: 340 },
      ports: reportGuardPorts,
      config: {},
    },
    {
      id: "static_report_assembler",
      type: "computer_report_assembler",
      typeVersion: "1.0.0",
      position: { x: 2920, y: -560 },
      size: { width: 320, height: 420 },
      ports: reportAssemblerPorts,
      config: {},
    },
    {
      id: "static_report_guard",
      type: "computer_report_guard",
      typeVersion: "1.0.0",
      position: { x: 3280, y: -560 },
      size: { width: 300, height: 340 },
      ports: reportGuardPorts,
      config: {},
    },
    {
      id: "commerce_loop_begin",
      type: "loop_begin",
      typeVersion: "1.0.0",
      position: { x: 3400, y: 0 },
      size: { width: 300, height: 320 },
      ports: commerceLoopBeginPorts,
      config: { maxIterations: 32, checkMode: "after", onError: "route", timeoutMs: 480000 },
    },
    {
      id: "revision_search", type: "computer_revision_search", typeVersion: "1.0.0",
      position: { x: 3600, y: 520 }, size: { width: 300, height: 340 }, config: {},
      ports: [
        { id: "in", direction: "input", kind: "control", label: "开始" },
        { id: "state", direction: "input", kind: "data", label: "当前方案" },
        { id: "out", direction: "output", kind: "control", label: "继续核价" },
        { id: "research", direction: "output", kind: "control", label: "分析搜索结果" },
        { id: "state", direction: "output", kind: "data", label: "当前状态" },
        { id: "context", direction: "output", kind: "data", label: "搜索证据" },
        { id: "prompt", direction: "output", kind: "data", label: "替代分析输入" },
      ],
    },
    computerLlmNode("revision_planner", { x: 4000, y: 520 }, { maxTokens: 1800, temperature: 0, jsonOutput: true }),
    {
      id: "revision_draft_merge", type: "merge", typeVersion: "1.0.0",
      position: { x: 4360, y: 520 }, size: { width: 280, height: 200 }, ports: mergePorts, config: {},
    },
    {
      id: "revision_guard", type: "computer_revision_guard", typeVersion: "1.0.0",
      position: { x: 4700, y: 520 }, size: { width: 280, height: 240 }, config: {},
      ports: [
        { id: "in", direction: "input", kind: "control", label: "校验" },
        { id: "context", direction: "input", kind: "data", label: "搜索证据" },
        { id: "draft", direction: "input", kind: "data", label: "替代方案" },
        { id: "out", direction: "output", kind: "control", label: "继续" },
        { id: "state", direction: "output", kind: "data", label: "核实后状态" },
      ],
    },
    {
      id: "revision_state_merge", type: "merge", typeVersion: "1.0.0",
      position: { x: 5060, y: 520 }, size: { width: 280, height: 200 }, ports: mergePorts, config: {},
    },
    {
      id: "query_scheduler_loop",
      type: "commerce_query_scheduler",
      typeVersion: "1.0.0",
      position: { x: 3780, y: 0 },
      size: { width: 300, height: 360 },
      ports: querySchedulerPorts,
      config: { researchEnabled: true, maxWaveQueries: 1, maxTotalQueries: 32, maxAttemptsPerSlot: 3, wallClockLimitMs: 480000 },
    },
    {
      id: "product_search_loop",
      type: "browser_commerce",
      typeVersion: "1.0.0",
      position: { x: 4140, y: 0 },
      size: { width: 300, height: 380 },
      ports: browserCommercePorts,
      config: { maxQueries: 1 },
    },
    {
      id: "optimizer_v2_loop",
      type: "computer_recommendation_optimizer_v2",
      typeVersion: "1.0.0",
      position: { x: 4500, y: 0 },
      size: { width: 320, height: 440 },
      ports: optimizerV2Ports,
      config: { researchEnabled: true, maxNoProgressWaves: 3, wallClockLimitMs: 480000, terminal: false },
    },
    {
      id: "loop_iteration_merge",
      type: "merge",
      typeVersion: "1.0.0",
      position: { x: 4880, y: 0 },
      size: { width: 260, height: 180 },
      ports: mergePorts,
      config: {},
    },
    {
      id: "commerce_loop_end",
      type: "loop_end",
      typeVersion: "1.0.0",
      position: { x: 5200, y: 0 },
      size: { width: 300, height: 320 },
      ports: commerceLoopEndPorts,
      config: { condition: "nextState.continue == true" },
    },
    {
      id: "selection_merge",
      type: "merge",
      typeVersion: "1.0.0",
      position: { x: 5580, y: 0 },
      size: { width: 280, height: 220 },
      ports: mergePorts,
      config: {},
    },
    {
      id: "product_links",
      type: "computer_product_links",
      typeVersion: "1.0.0",
      position: { x: 5940, y: 0 },
      size: { width: 320, height: 360 },
      ports: productLinkPorts,
      config: {},
    },
    {
      id: "commerce_report_assembler",
      type: "computer_report_assembler",
      typeVersion: "1.0.0",
      position: { x: 6300, y: 0 },
      size: { width: 320, height: 420 },
      ports: reportAssemblerPorts,
      config: {},
    },
    {
      id: "commerce_report_guard",
      type: "computer_report_guard",
      typeVersion: "1.0.0",
      position: { x: 6660, y: 0 },
      size: { width: 300, height: 340 },
      ports: reportGuardPorts,
      config: {},
    },
    {
      id: "final_answer_merge",
      type: "merge",
      typeVersion: "1.0.0",
      position: { x: 7020, y: 0 },
      size: { width: 280, height: 220 },
      ports: mergePorts,
      config: {},
    },
    {
      id: "end",
      type: "end",
      typeVersion: "1.0.0",
      position: { x: 7380, y: 0 },
      size: { width: 280, height: 96 },
      ports: [{ id: "in", direction: "input", kind: "control", label: "运行" }],
      config: {},
    },
  ],
  edges: [
    { id: "edge_v4_start_context", from: { nodeId: "start", portId: "out" }, to: { nodeId: "advisor_context", portId: "in" } },
    { id: "edge_v4_request_context", from: { nodeId: "start", portId: "runInput" }, to: { nodeId: "advisor_context", portId: "request" } },
    { id: "edge_v4_context_requirement", from: { nodeId: "advisor_context", portId: "out" }, to: { nodeId: "requirement_planner", portId: "in" } },
    { id: "edge_v4_requirement_prompt", from: { nodeId: "advisor_context", portId: "requirementPrompt" }, to: { nodeId: "requirement_planner", portId: "prompt" } },
    { id: "edge_v4_requirement_success", from: { nodeId: "requirement_planner", portId: "out" }, to: { nodeId: "requirement_draft_merge", portId: "in" } },
    { id: "edge_v4_requirement_result", from: { nodeId: "requirement_planner", portId: "result" }, to: { nodeId: "requirement_draft_merge", portId: "value" } },
    { id: "edge_v4_requirement_error", from: { nodeId: "requirement_planner", portId: "error" }, to: { nodeId: "requirement_draft_merge", portId: "value" } },
    { id: "edge_v4_requirement_policy_control", from: { nodeId: "requirement_draft_merge", portId: "out" }, to: { nodeId: "requirement_policy_v2", portId: "in" } },
    { id: "edge_v4_requirement_policy_draft", from: { nodeId: "requirement_draft_merge", portId: "value" }, to: { nodeId: "requirement_policy_v2", portId: "draft" } },
    { id: "edge_v4_requirement_policy_request", from: { nodeId: "start", portId: "runInput" }, to: { nodeId: "requirement_policy_v2", portId: "request" } },
    { id: "edge_v4_blueprint_control", from: { nodeId: "requirement_policy_v2", portId: "needsBlueprint" }, to: { nodeId: "blueprint_planner", portId: "in" } },
    { id: "edge_v4_blueprint_prompt", from: { nodeId: "requirement_policy_v2", portId: "blueprintPrompt" }, to: { nodeId: "blueprint_planner", portId: "prompt" } },
    { id: "edge_v4_blueprint_success", from: { nodeId: "blueprint_planner", portId: "out" }, to: { nodeId: "blueprint_draft_merge", portId: "in" } },
    { id: "edge_v4_blueprint_result", from: { nodeId: "blueprint_planner", portId: "result" }, to: { nodeId: "blueprint_draft_merge", portId: "value" } },
    { id: "edge_v4_blueprint_error", from: { nodeId: "blueprint_planner", portId: "error" }, to: { nodeId: "blueprint_draft_merge", portId: "value" } },
    { id: "edge_v4_blueprint_guard_control", from: { nodeId: "blueprint_draft_merge", portId: "out" }, to: { nodeId: "blueprint_guard", portId: "in" } },
    { id: "edge_v4_blueprint_guard_draft", from: { nodeId: "blueprint_draft_merge", portId: "value" }, to: { nodeId: "blueprint_guard", portId: "draft" } },
    { id: "edge_v4_blueprint_guard_requirements", from: { nodeId: "requirement_policy_v2", portId: "requirements" }, to: { nodeId: "blueprint_guard", portId: "requirements" } },
    { id: "edge_v4_blueprint_guard_request", from: { nodeId: "start", portId: "runInput" }, to: { nodeId: "blueprint_guard", portId: "request" } },
    { id: "edge_v4_direct_control", from: { nodeId: "requirement_policy_v2", portId: "needsDirect" }, to: { nodeId: "direct_model", portId: "in" } },
    { id: "edge_v4_direct_prompt", from: { nodeId: "requirement_policy_v2", portId: "directPrompt" }, to: { nodeId: "direct_model", portId: "prompt" } },
    { id: "edge_v4_direct_error_guard", from: { nodeId: "direct_model", portId: "error" }, to: { nodeId: "direct_failure_guard", portId: "polishError" } },
    { id: "edge_v4_direct_fallback_report", from: { nodeId: "requirement_policy_v2", portId: "directFallback" }, to: { nodeId: "direct_failure_guard", portId: "report" } },
    { id: "edge_v4_direct_fallback_candidate", from: { nodeId: "requirement_policy_v2", portId: "directFallback" }, to: { nodeId: "direct_failure_guard", portId: "candidate" } },
    { id: "edge_v4_static_report_control", from: { nodeId: "blueprint_guard", portId: "reportReady" }, to: { nodeId: "static_report_assembler", portId: "in" } },
    { id: "edge_v4_static_report_requirements", from: { nodeId: "blueprint_guard", portId: "requirements" }, to: { nodeId: "static_report_assembler", portId: "requirements" } },
    { id: "edge_v4_static_report_blueprint", from: { nodeId: "blueprint_guard", portId: "blueprint" }, to: { nodeId: "static_report_assembler", portId: "blueprint" } },
    { id: "edge_v4_static_report_state", from: { nodeId: "blueprint_guard", portId: "state" }, to: { nodeId: "static_report_assembler", portId: "state" } },
    { id: "edge_v4_static_guard_control", from: { nodeId: "static_report_assembler", portId: "out" }, to: { nodeId: "static_report_guard", portId: "in" } },
    { id: "edge_v4_static_guard_report", from: { nodeId: "static_report_assembler", portId: "report" }, to: { nodeId: "static_report_guard", portId: "report" } },
    { id: "edge_v4_static_guard_candidate", from: { nodeId: "static_report_assembler", portId: "report" }, to: { nodeId: "static_report_guard", portId: "candidate" } },
    { id: "edge_v4_loop_start", from: { nodeId: "blueprint_guard", portId: "needsCommerce" }, to: { nodeId: "commerce_loop_begin", portId: "in" } },
    { id: "edge_v4_loop_initial_state", from: { nodeId: "blueprint_guard", portId: "state" }, to: { nodeId: "commerce_loop_begin", portId: "initialState" } },
    { id: "edge_v4_loop_body", from: { nodeId: "commerce_loop_begin", portId: "body" }, to: { nodeId: "revision_search", portId: "in" } },
    { id: "edge_v4_loop_blueprint", from: { nodeId: "blueprint_guard", portId: "blueprint" }, to: { nodeId: "query_scheduler_loop", portId: "blueprint" } },
    { id: "edge_v4_loop_state", from: { nodeId: "commerce_loop_begin", portId: "state" }, to: { nodeId: "revision_search", portId: "state" } },
    { id: "edge_revision_0", from: { nodeId: "revision_search", portId: "research" }, to: { nodeId: "revision_planner", portId: "in" } },
    { id: "edge_revision_1", from: { nodeId: "revision_search", portId: "prompt" }, to: { nodeId: "revision_planner", portId: "prompt" } },
    { id: "edge_revision_2", from: { nodeId: "revision_planner", portId: "out" }, to: { nodeId: "revision_draft_merge", portId: "in" } },
    { id: "edge_revision_3", from: { nodeId: "revision_planner", portId: "result" }, to: { nodeId: "revision_draft_merge", portId: "value" } },
    { id: "edge_revision_4", from: { nodeId: "revision_planner", portId: "error" }, to: { nodeId: "revision_draft_merge", portId: "value" } },
    { id: "edge_revision_5", from: { nodeId: "revision_draft_merge", portId: "out" }, to: { nodeId: "revision_guard", portId: "in" } },
    { id: "edge_revision_6", from: { nodeId: "revision_draft_merge", portId: "value" }, to: { nodeId: "revision_guard", portId: "draft" } },
    { id: "edge_revision_7", from: { nodeId: "revision_search", portId: "context" }, to: { nodeId: "revision_guard", portId: "context" } },
    { id: "edge_revision_8", from: { nodeId: "revision_guard", portId: "out" }, to: { nodeId: "revision_state_merge", portId: "in" } },
    { id: "edge_revision_9", from: { nodeId: "revision_guard", portId: "state" }, to: { nodeId: "revision_state_merge", portId: "value" } },
    { id: "edge_revision_10", from: { nodeId: "revision_search", portId: "out" }, to: { nodeId: "revision_state_merge", portId: "in" } },
    { id: "edge_revision_11", from: { nodeId: "revision_search", portId: "state" }, to: { nodeId: "revision_state_merge", portId: "value" } },
    { id: "edge_revision_12", from: { nodeId: "revision_state_merge", portId: "out" }, to: { nodeId: "query_scheduler_loop", portId: "in" } },
    { id: "edge_revision_13", from: { nodeId: "revision_state_merge", portId: "value" }, to: { nodeId: "query_scheduler_loop", portId: "state" } },
    { id: "edge_v4_loop_discovery_control", from: { nodeId: "query_scheduler_loop", portId: "out" }, to: { nodeId: "product_search_loop", portId: "in" } },
    { id: "edge_v4_loop_query_plan", from: { nodeId: "query_scheduler_loop", portId: "queryPlan" }, to: { nodeId: "product_search_loop", portId: "plan" } },
    { id: "edge_v4_loop_request", from: { nodeId: "start", portId: "runInput" }, to: { nodeId: "product_search_loop", portId: "request" } },
    { id: "edge_v4_loop_optimizer_control", from: { nodeId: "product_search_loop", portId: "out" }, to: { nodeId: "optimizer_v2_loop", portId: "in" } },
    { id: "edge_v4_loop_requirements", from: { nodeId: "blueprint_guard", portId: "requirements" }, to: { nodeId: "optimizer_v2_loop", portId: "requirements" } },
    { id: "edge_v4_loop_optimizer_blueprint", from: { nodeId: "blueprint_guard", portId: "blueprint" }, to: { nodeId: "optimizer_v2_loop", portId: "blueprint" } },
    { id: "edge_v4_loop_previous_state", from: { nodeId: "query_scheduler_loop", portId: "state" }, to: { nodeId: "optimizer_v2_loop", portId: "previousState" } },
    { id: "edge_v4_loop_queries", from: { nodeId: "product_search_loop", portId: "queries" }, to: { nodeId: "optimizer_v2_loop", portId: "queries" } },
    { id: "edge_v4_loop_products", from: { nodeId: "product_search_loop", portId: "products" }, to: { nodeId: "optimizer_v2_loop", portId: "products" } },
    { id: "edge_v4_loop_telemetry", from: { nodeId: "product_search_loop", portId: "telemetry" }, to: { nodeId: "optimizer_v2_loop", portId: "telemetry" } },
    { id: "edge_v4_loop_errors", from: { nodeId: "product_search_loop", portId: "errors" }, to: { nodeId: "optimizer_v2_loop", portId: "errors" } },
    { id: "edge_v4_loop_repair_done", from: { nodeId: "optimizer_v2_loop", portId: "repair" }, to: { nodeId: "loop_iteration_merge", portId: "in" } },
    { id: "edge_v4_loop_complete_done", from: { nodeId: "optimizer_v2_loop", portId: "complete" }, to: { nodeId: "loop_iteration_merge", portId: "in" } },
    { id: "edge_v4_loop_iteration_done", from: { nodeId: "loop_iteration_merge", portId: "out" }, to: { nodeId: "commerce_loop_end", portId: "body_done" } },
    { id: "edge_v4_loop_next_state", from: { nodeId: "optimizer_v2_loop", portId: "selection" }, to: { nodeId: "commerce_loop_end", portId: "nextState" } },
    { id: "edge_v4_loop_done_selection", from: { nodeId: "commerce_loop_end", portId: "done" }, to: { nodeId: "selection_merge", portId: "in" } },
    { id: "edge_v4_loop_maxed_selection", from: { nodeId: "commerce_loop_end", portId: "maxed" }, to: { nodeId: "selection_merge", portId: "in" } },
    { id: "edge_v4_loop_timeout_selection", from: { nodeId: "commerce_loop_end", portId: "timeout" }, to: { nodeId: "selection_merge", portId: "in" } },
    { id: "edge_v4_loop_error_selection", from: { nodeId: "commerce_loop_end", portId: "error" }, to: { nodeId: "selection_merge", portId: "in" } },
    { id: "edge_v4_loop_final_state", from: { nodeId: "commerce_loop_end", portId: "finalState" }, to: { nodeId: "selection_merge", portId: "value" } },
    { id: "edge_v4_selection_links_control", from: { nodeId: "selection_merge", portId: "out" }, to: { nodeId: "product_links", portId: "in" } },
    { id: "edge_v4_selection_links_data", from: { nodeId: "selection_merge", portId: "value" }, to: { nodeId: "product_links", portId: "selection" } },
    { id: "edge_v4_commerce_report_control", from: { nodeId: "product_links", portId: "out" }, to: { nodeId: "commerce_report_assembler", portId: "in" } },
    { id: "edge_v4_commerce_report_requirements", from: { nodeId: "blueprint_guard", portId: "requirements" }, to: { nodeId: "commerce_report_assembler", portId: "requirements" } },
    { id: "edge_v4_commerce_report_blueprint", from: { nodeId: "blueprint_guard", portId: "blueprint" }, to: { nodeId: "commerce_report_assembler", portId: "blueprint" } },
    { id: "edge_v4_commerce_report_state", from: { nodeId: "product_links", portId: "state" }, to: { nodeId: "commerce_report_assembler", portId: "state" } },
    { id: "edge_v4_commerce_report_products", from: { nodeId: "product_links", portId: "products" }, to: { nodeId: "commerce_report_assembler", portId: "products" } },
    { id: "edge_v4_commerce_guard_control", from: { nodeId: "commerce_report_assembler", portId: "out" }, to: { nodeId: "commerce_report_guard", portId: "in" } },
    { id: "edge_v4_commerce_guard_report", from: { nodeId: "commerce_report_assembler", portId: "report" }, to: { nodeId: "commerce_report_guard", portId: "report" } },
    { id: "edge_v4_commerce_guard_candidate", from: { nodeId: "commerce_report_assembler", portId: "report" }, to: { nodeId: "commerce_report_guard", portId: "candidate" } },
    { id: "edge_v4_direct_final_control", from: { nodeId: "direct_model", portId: "out" }, to: { nodeId: "final_answer_merge", portId: "in" } },
    { id: "edge_v4_direct_final_value", from: { nodeId: "direct_model", portId: "result" }, to: { nodeId: "final_answer_merge", portId: "value" } },
    { id: "edge_v4_direct_failure_final_control", from: { nodeId: "direct_failure_guard", portId: "out" }, to: { nodeId: "final_answer_merge", portId: "in" } },
    { id: "edge_v4_direct_failure_final_value", from: { nodeId: "direct_failure_guard", portId: "answer" }, to: { nodeId: "final_answer_merge", portId: "value" } },
    { id: "edge_v4_static_final_control", from: { nodeId: "static_report_guard", portId: "out" }, to: { nodeId: "final_answer_merge", portId: "in" } },
    { id: "edge_v4_static_final_value", from: { nodeId: "static_report_guard", portId: "answer" }, to: { nodeId: "final_answer_merge", portId: "value" } },
    { id: "edge_v4_commerce_final_control", from: { nodeId: "commerce_report_guard", portId: "out" }, to: { nodeId: "final_answer_merge", portId: "in" } },
    { id: "edge_v4_commerce_final_value", from: { nodeId: "commerce_report_guard", portId: "answer" }, to: { nodeId: "final_answer_merge", portId: "value" } },
    { id: "edge_v4_end", from: { nodeId: "final_answer_merge", portId: "out" }, to: { nodeId: "end", portId: "in" } },
  ],
} as const;

function maxOutputTokensConfiguration(defaultValue: number) {
  return {
    name: FLOW_MAX_OUTPUT_TOKENS_VARIABLE,
    label: "最大输出 Token",
    description: "模型思考内容和最终正文共享此预算；推理模型建议使用 16384 或更高。",
    type: "select",
    defaultValue,
    options: [
      { label: "4K · 4096", value: 4096 },
      { label: "6K · 6144", value: 6144 },
      { label: "8K · 8192", value: 8192 },
      { label: "16K · 16384（推荐推理模型）", value: 16384 },
      { label: "24K · 24576", value: 24576 },
      { label: "32K · 32000", value: 32000 },
    ],
  } as const;
}

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
      id: BUILTIN_WEB_SEARCH_PLANNER_FLOW_ID,
      version: BUILTIN_WEB_SEARCH_PLANNER_FLOW_VERSION,
      name: "联网搜索词规划",
      graph: BUILTIN_WEB_SEARCH_PLANNER_FLOW,
    },
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
