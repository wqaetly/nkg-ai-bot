import {
  BUILTIN_CHAT_FLOW_ID,
  BUILTIN_CHAT_FLOW_VERSION,
} from "./builtinFlows";
import type { AssistantSkillVersion } from "./assistantSkills";
import type { McpServerInput } from "./mcpConfig";

export interface MarketSkill extends Omit<AssistantSkillVersion, "createdAt"> {
  category: "效率" | "学习" | "创作";
  featured?: boolean;
}

export interface MarketMcpTemplate extends McpServerInput {
  category: "搜索" | "记忆" | "自动化";
  featured?: boolean;
}

export const MARKET_SKILLS: MarketSkill[] = [
  {
    assistantId: "market_writing_partner",
    version: "1.0.0",
    name: "写作搭档",
    description: "从提纲、初稿到润色，保持语气和事实边界一致。",
    systemPrompt: "你是一名克制、可靠的中文写作搭档。先确认受众、目标和语气，再协助用户完成提纲、改写、压缩或润色。保留事实边界，不编造来源。",
    flowId: BUILTIN_CHAT_FLOW_ID,
    flowVersion: BUILTIN_CHAT_FLOW_VERSION,
    memoryNamespace: "skill_writing_partner",
    capabilities: ["network.http", "secret.read"],
    activationHints: ["内容润色", "结构重写", "提纲生成"],
    category: "创作",
    featured: true,
  },
  {
    assistantId: "market_study_coach",
    version: "1.0.0",
    name: "学习教练",
    description: "把复杂主题拆成可复习、可自测的学习路径。",
    systemPrompt: "你是一名循序渐进的学习教练。先评估用户基础，再用解释、例子、主动回忆问题和小测验组织学习，不直接替用户跳过关键推理。",
    flowId: BUILTIN_CHAT_FLOW_ID,
    flowVersion: BUILTIN_CHAT_FLOW_VERSION,
    memoryNamespace: "skill_study_coach",
    capabilities: ["network.http", "secret.read"],
    activationHints: ["概念讲解", "复习计划", "知识自测"],
    category: "学习",
  },
  {
    assistantId: "market_action_planner",
    version: "1.0.0",
    name: "行动规划师",
    description: "把目标转成有依赖关系、验收标准和复盘点的计划。",
    systemPrompt: "你是一名行动规划助手。澄清目标、约束和截止时间后，将工作拆成最小可执行步骤，标明依赖、风险、完成标准和复盘节点。",
    flowId: BUILTIN_CHAT_FLOW_ID,
    flowVersion: BUILTIN_CHAT_FLOW_VERSION,
    memoryNamespace: "skill_action_planner",
    capabilities: ["network.http", "secret.read"],
    activationHints: ["目标拆解", "项目计划", "风险清单"],
    category: "效率",
  },
];

export const MARKET_MCP_TEMPLATES: MarketMcpTemplate[] = [
  {
    id: "memos-context",
    name: "MemOS Context",
    description: "通过 Streamable HTTP 连接远端记忆与上下文工具。",
    endpoint: "http://127.0.0.1:8000/mcp",
    transport: "streamable-http",
    authHeaderRef: "",
    enabled: false,
    category: "记忆",
    featured: true,
  },
  {
    id: "search-tools",
    name: "Search Tools",
    description: "接入自托管搜索 MCP，在对话中发现和调用检索工具。",
    endpoint: "http://127.0.0.1:3001/mcp",
    transport: "streamable-http",
    authHeaderRef: "",
    enabled: false,
    category: "搜索",
  },
  {
    id: "local-automation",
    name: "Local Automation",
    description: "连接本地自动化服务；启用前请先确认工具权限范围。",
    endpoint: "http://127.0.0.1:8787/mcp",
    transport: "streamable-http",
    authHeaderRef: "",
    enabled: false,
    category: "自动化",
  },
];
