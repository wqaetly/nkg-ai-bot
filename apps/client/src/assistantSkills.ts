import {
  BUILTIN_CHAT_FLOW_ID,
  BUILTIN_CHAT_FLOW_VERSION,
  COMPUTER_CONFIG_FLOW_ID,
  COMPUTER_CONFIG_FLOW_VERSION,
} from "./builtinFlows";
import { getDatabase, type DatabaseClient } from "./storage/database";

export const DEFAULT_ASSISTANT_ID = "builtin_assistant";
export const DEFAULT_ASSISTANT_VERSION = "1.0.2";
export const DEFAULT_ASSISTANT_SYSTEM_PROMPT =
  "你是一个可靠、自然的 AI 对话助手。请直接回答最后一条用户消息，并结合前文保持上下文一致。";
export const COMPUTER_CONFIG_ASSISTANT_ID = "computer_config_advisor";
export const COMPUTER_CONFIG_ASSISTANT_VERSION = "4.4.0";
export const COMPUTER_CONFIG_SYSTEM_PROMPT = `你是“电脑配置顾问”，专门提供客观、可执行、可核验的台式机装机、品牌整机、笔记本、局部配件、现有配置诊断与升级建议。

工作规则：
1. 严格遵守 Flow 给出的 intent、targetParts、ownedParts、excludedParts 和预算覆盖范围。DIY 整套才覆盖完整部件；局部配件和升级只回答目标部件；品牌整机与笔记本按整机 SKU 比较，禁止强行拆成八件配置。
2. 用户要求推荐时，必须先给出完整、可执行的推荐清单，不得先提问或只回复澄清问题。信息不足时采用清楚标注的合理默认假设；所有疑问、风险和需要用户选择的事项统一放在回答最后，合并为最多三项，让用户在已有方案上定夺。
3. Flow V4 的技术蓝图、coverage、stopReason、selectedCandidates 与实价小计是唯一业务事实来源。联网检索先确认适合预算与用途的当前型号候选，联盟电商 API 再核验真实在售价格；联网网页价格不得冒充核价结果。只有本轮联盟 API 观察到的价格才算实价；部分槽位有实价时只能给“已核验小计”，不得心算整机总价。硬预算不得超出或被隐式提高；已核验完整组合超预算时必须如实标记超预算，不能拿缺件方案冒充成功。
4. 必须检查兼容性与平衡性：CPU 插槽和主板芯片组、内存代际、散热高度/冷排、显卡尺寸、机箱规格、电源额定功率和接口、存储与 PCIe 通道、显示输出和前置接口。结构化校验的 error 是阻断项；warning 和未知字段是系统尚未完成的校验状态，集中说明一次，不得转写成让用户逐项自行核验的购买清单。
5. 输出按场景先给推荐结论与完整清单，再给预算状态、兼容性结论、替代方案和升级路线，最后给问题与待确认项；不适用的章节可以省略。实时商品未覆盖的部件仍要给出明确型号或规格，并只在预算结论处集中说明一次系统本轮未匹配到实时商品，不能从清单中删除，也不能把检索工作转交用户。
6. 涉及当前价格、库存、新发布硬件或近期性能数据时，只能把本轮联网搜索与联盟电商 API 结果当作时效证据，并注明地区与查询日期；没有证据就如实报告系统检索状态一次。不要编造来源、跑分、商品链接或优惠，不要反复输出“请自行核价/核验”。
7. 购物路径的最终正文由 Flow V4 确定性报告节点生成。只能展示最终 selectedCandidates 中通过品类、型号与价格校验且成功转链的商品，并集中披露一次“推广链接，用户购买后平台可能向我们支付佣金”。不得改写报告中的价格、链接、槽位行、覆盖率或停止原因，也不得展示未通过校验的候选。
8. 清楚区分事实、合理推断和个人取舍。用户提供现有配置或截图时，先逐项提取并复述不确定字段，再分析瓶颈和升级优先级。

默认使用简体中文和人民币；如果用户给出其他地区、语言或币种，则跟随用户。`;

export interface AssistantSkillVersion {
  assistantId: string;
  version: string;
  name: string;
  description: string;
  systemPrompt: string;
  flowId: string;
  flowVersion: string;
  memoryNamespace: string;
  capabilities: string[];
  activationHints: string[];
  createdAt: number;
}

/** Compact discovery shape; the full prompt is loaded only after selection. */
export interface AssistantSkillIndex {
  assistantId: string;
  activeVersion: string;
  previousVersion?: string;
  name: string;
  description: string;
  flowId: string;
  flowVersion: string;
  capabilities: string[];
  activationHints: string[];
  pinned: boolean;
  archived: boolean;
  useCount: number;
  successCount: number;
  failureCount: number;
  lastUsedAt?: number;
  updatedAt: number;
}

export function filterAssistantSkillIndex(
  skills: AssistantSkillIndex[],
  query: string,
): AssistantSkillIndex[] {
  const terms = query
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return skills;
  return skills.filter((skill) => {
    const searchableText = [
      skill.name,
      skill.description,
      skill.assistantId,
      ...skill.capabilities,
      ...skill.activationHints,
    ].join("\n").normalize("NFKC").toLocaleLowerCase();
    return terms.every((term) => searchableText.includes(term));
  });
}

export type AssistantRunStatus = "succeeded" | "failed" | "cancelled" | "interrupted";

type VersionRow = {
  assistant_id: string;
  version: string;
  name: string;
  description: string;
  system_prompt: string;
  flow_id: string;
  flow_version: string;
  memory_namespace: string;
  capabilities_json: string;
  activation_hints_json: string;
  created_at: number;
};

type IndexRow = {
  assistant_id: string;
  active_version: string;
  previous_version: string | null;
  name: string;
  description: string;
  flow_id: string;
  flow_version: string;
  capabilities_json: string;
  activation_hints_json: string;
  pinned: number;
  archived_at: number | null;
  use_count: number;
  success_count: number;
  failure_count: number;
  last_used_at: number | null;
  updated_at: number;
};

type RunLinkRow = {
  assistant_id: string;
  assistant_version: string;
  status: string;
};

export async function ensureBuiltinAssistantSkills(client?: DatabaseClient): Promise<void> {
  const database = client ?? await getDatabase();
  const now = Date.now();
  const definitions = [
    {
      assistantId: DEFAULT_ASSISTANT_ID,
      version: DEFAULT_ASSISTANT_VERSION,
      name: "NKG",
      description: "通用本地 AI 助手",
      systemPrompt: DEFAULT_ASSISTANT_SYSTEM_PROMPT,
      flowId: BUILTIN_CHAT_FLOW_ID,
      flowVersion: BUILTIN_CHAT_FLOW_VERSION,
      memoryNamespace: "global",
      capabilities: ["network.http", "secret.read"],
      activationHints: ["通用问答", "整理想法", "制定计划"],
      previousBuiltinVersions: ["1.0.0", "1.0.1"],
    },
    {
      assistantId: COMPUTER_CONFIG_ASSISTANT_ID,
      version: COMPUTER_CONFIG_ASSISTANT_VERSION,
      name: "电脑配置顾问",
      description: "专业电脑配置、兼容性、性能瓶颈与升级建议",
      systemPrompt: COMPUTER_CONFIG_SYSTEM_PROMPT,
      flowId: COMPUTER_CONFIG_FLOW_ID,
      flowVersion: COMPUTER_CONFIG_FLOW_VERSION,
      memoryNamespace: "computer_config",
      capabilities: ["network.http", "secret.read"],
      activationHints: ["专业装机", "预算配置单", "兼容性检查", "升级建议", "笔记本选购"],
      previousBuiltinVersions: ["2.0.0", "2.1.0", "3.0.0", "3.0.1", "3.0.2", "3.0.3", "3.0.4", "3.0.5", "3.0.6", "4.0.0", "4.1.0", "4.2.0", "4.2.1", "4.2.2", "4.3.0", "4.3.1"],
    },
  ] as const;
  for (const definition of definitions) {
    await seedBuiltinAssistantSkill(database, definition, now);
  }
}

async function seedBuiltinAssistantSkill(
  database: DatabaseClient,
  definition: {
    assistantId: string;
    version: string;
    name: string;
    description: string;
    systemPrompt: string;
    flowId: string;
    flowVersion: string;
    memoryNamespace: string;
    capabilities: readonly string[];
    activationHints: readonly string[];
    previousBuiltinVersions?: readonly string[];
  },
  now: number,
): Promise<void> {
  await database.execute(
    `INSERT INTO assistants
       (id, name, description, flow_id, flow_version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT(id) DO NOTHING`,
    [
      definition.assistantId,
      definition.name,
      definition.description,
      definition.flowId,
      definition.flowVersion,
      now,
    ],
  );
  await database.execute(
    `INSERT INTO assistant_versions
       (assistant_id, version, name, description, system_prompt, flow_id, flow_version,
        memory_namespace, capabilities_json, activation_hints_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT(assistant_id, version) DO NOTHING`,
    [
      definition.assistantId,
      definition.version,
      definition.name,
      definition.description,
      definition.systemPrompt,
      definition.flowId,
      definition.flowVersion,
      definition.memoryNamespace,
      JSON.stringify(definition.capabilities),
      JSON.stringify(definition.activationHints),
      now,
    ],
  );
  await database.execute(
    `INSERT INTO assistant_active
       (assistant_id, active_version, previous_version, pinned, archived_at, updated_at)
     VALUES ($1, $2, NULL, 1, NULL, $3)
     ON CONFLICT(assistant_id) DO NOTHING`,
    [definition.assistantId, definition.version, now],
  );
  if (definition.previousBuiltinVersions?.length) {
    const placeholders = definition.previousBuiltinVersions
      .map((_, index) => `$${index + 3}`)
      .join(", ");
    await database.execute(
      `UPDATE assistant_active
          SET previous_version=active_version,
              active_version=$2,
              updated_at=$${definition.previousBuiltinVersions.length + 3}
        WHERE assistant_id=$1 AND active_version IN (${placeholders})`,
      [definition.assistantId, definition.version, ...definition.previousBuiltinVersions, now],
    );
    await database.execute(
      `UPDATE conversations
          SET assistant_version=$2,
              updated_at=$${definition.previousBuiltinVersions.length + 3}
        WHERE assistant_id=$1
          AND assistant_version IN (${placeholders})
          AND EXISTS (
            SELECT 1 FROM assistant_active current
             WHERE current.assistant_id=$1 AND current.active_version=$2
          )`,
      [definition.assistantId, definition.version, ...definition.previousBuiltinVersions, now],
    );
  }
  await database.execute(
    `INSERT INTO assistant_skill_usage
       (assistant_id, assistant_version, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT(assistant_id, assistant_version) DO NOTHING`,
    [definition.assistantId, definition.version, now],
  );
}

export async function listAssistantSkillIndex(
  options: { includeArchived?: boolean } = {},
  client?: DatabaseClient,
): Promise<AssistantSkillIndex[]> {
  const database = client ?? await getDatabase();
  const rows = await database.select<IndexRow[]>(
    `SELECT current.assistant_id, current.active_version, current.previous_version,
            version.name, version.description, version.flow_id, version.flow_version,
            version.capabilities_json, version.activation_hints_json,
            current.pinned, current.archived_at, current.updated_at,
            COALESCE(usage.use_count, 0) AS use_count,
            COALESCE(usage.success_count, 0) AS success_count,
            COALESCE(usage.failure_count, 0) AS failure_count,
            usage.last_used_at
       FROM assistant_active current
       JOIN assistant_versions version
         ON version.assistant_id=current.assistant_id AND version.version=current.active_version
       LEFT JOIN assistant_skill_usage usage
         ON usage.assistant_id=current.assistant_id AND usage.assistant_version=current.active_version
      WHERE ($1 = 1 OR current.archived_at IS NULL)
      ORDER BY current.pinned DESC, COALESCE(usage.last_used_at, 0) DESC, version.name`,
    [options.includeArchived ? 1 : 0],
  );
  return rows.map(mapIndex);
}

export async function getAssistantSkillVersion(
  assistantId: string,
  version: string,
  client?: DatabaseClient,
): Promise<AssistantSkillVersion | undefined> {
  const database = client ?? await getDatabase();
  const [row] = await database.select<VersionRow[]>(
    "SELECT * FROM assistant_versions WHERE assistant_id=$1 AND version=$2",
    [assistantId, version],
  );
  return row ? mapVersion(row) : undefined;
}

export async function resolveAssistantSkill(
  assistantId?: string,
  version?: string,
  client?: DatabaseClient,
): Promise<AssistantSkillVersion> {
  const database = client ?? await getDatabase();
  if (assistantId && version) {
    const exact = await getAssistantSkillVersion(assistantId, version, database);
    if (!exact) throw new Error(`Assistant Skill ${assistantId}@${version} was not found`);
    return exact;
  }
  if (assistantId) {
    const [row] = await database.select<Array<{ active_version: string }>>(
      "SELECT active_version FROM assistant_active WHERE assistant_id=$1",
      [assistantId],
    );
    if (row) {
      const active = await getAssistantSkillVersion(assistantId, row.active_version, database);
      if (active) return active;
    }
  }
  const [preferred] = await listAssistantSkillIndex({}, database);
  if (!preferred) throw new Error("No active Assistant Skill is available");
  const resolved = await getAssistantSkillVersion(preferred.assistantId, preferred.activeVersion, database);
  if (!resolved) throw new Error("Active Assistant Skill version was not found");
  return resolved;
}

export async function publishAssistantSkillVersion(
  input: Omit<AssistantSkillVersion, "createdAt">,
  client?: DatabaseClient,
): Promise<AssistantSkillVersion> {
  validateVersionInput(input);
  const database = client ?? await getDatabase();
  const existing = await getAssistantSkillVersion(input.assistantId, input.version, database);
  if (existing) throw new Error("Assistant Skill version already exists and is immutable");
  const now = Date.now();
  await database.execute(
    `INSERT INTO assistant_versions
       (assistant_id, version, name, description, system_prompt, flow_id, flow_version,
        memory_namespace, capabilities_json, activation_hints_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.assistantId,
      input.version,
      input.name.trim(),
      input.description.trim(),
      input.systemPrompt.trim(),
      input.flowId,
      input.flowVersion,
      input.memoryNamespace.trim(),
      JSON.stringify(uniqueStrings(input.capabilities)),
      JSON.stringify(uniqueStrings(input.activationHints)),
      now,
    ],
  );
  await database.execute(
    `INSERT INTO assistant_skill_usage (assistant_id, assistant_version, updated_at)
     VALUES ($1, $2, $3)`,
    [input.assistantId, input.version, now],
  );
  const saved = await getAssistantSkillVersion(input.assistantId, input.version, database);
  if (!saved) throw new Error("Assistant Skill version was not persisted");
  return saved;
}

export async function promoteAssistantSkillVersion(
  assistantId: string,
  version: string,
  client?: DatabaseClient,
): Promise<string | undefined> {
  const database = client ?? await getDatabase();
  if (!await getAssistantSkillVersion(assistantId, version, database)) {
    throw new Error(`Assistant Skill ${assistantId}@${version} was not found`);
  }
  const now = Date.now();
  await database.execute(
    `INSERT INTO assistant_active
       (assistant_id, active_version, previous_version, pinned, archived_at, updated_at)
     VALUES ($1, $2, NULL, 0, NULL, $3)
     ON CONFLICT(assistant_id) DO UPDATE SET
       previous_version=CASE
         WHEN assistant_active.active_version <> excluded.active_version
         THEN assistant_active.active_version ELSE assistant_active.previous_version END,
       active_version=excluded.active_version,
       updated_at=excluded.updated_at`,
    [assistantId, version, now],
  );
  const [row] = await database.select<Array<{ previous_version: string | null }>>(
    "SELECT previous_version FROM assistant_active WHERE assistant_id=$1",
    [assistantId],
  );
  return row?.previous_version ?? undefined;
}

export async function rollbackAssistantSkill(
  assistantId: string,
  client?: DatabaseClient,
): Promise<void> {
  const database = client ?? await getDatabase();
  const [row] = await database.select<Array<{ previous_version: string | null }>>(
    "SELECT previous_version FROM assistant_active WHERE assistant_id=$1",
    [assistantId],
  );
  if (!row?.previous_version) throw new Error("Assistant Skill has no previous version to restore");
  await promoteAssistantSkillVersion(assistantId, row.previous_version, database);
}

export async function setAssistantSkillPinned(
  assistantId: string,
  pinned: boolean,
  client?: DatabaseClient,
): Promise<void> {
  const database = client ?? await getDatabase();
  await database.execute(
    "UPDATE assistant_active SET pinned=$2, updated_at=$3 WHERE assistant_id=$1",
    [assistantId, pinned ? 1 : 0, Date.now()],
  );
}

export async function setAssistantSkillArchived(
  assistantId: string,
  archived: boolean,
  client?: DatabaseClient,
): Promise<void> {
  const database = client ?? await getDatabase();
  await database.execute(
    "UPDATE assistant_active SET archived_at=$2, updated_at=$3 WHERE assistant_id=$1",
    [assistantId, archived ? Date.now() : null, Date.now()],
  );
}

export async function startAssistantSkillRun(
  input: {
    id: string;
    conversationId: string;
    userMessageId: string;
    skill: AssistantSkillVersion;
  },
  client?: DatabaseClient,
): Promise<void> {
  const database = client ?? await getDatabase();
  const now = Date.now();
  await database.execute(
    `INSERT INTO assistant_run_links
       (id, conversation_id, user_message_id, assistant_id, assistant_version,
        flow_id, flow_version, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8, $8)`,
    [
      input.id,
      input.conversationId,
      input.userMessageId,
      input.skill.assistantId,
      input.skill.version,
      input.skill.flowId,
      input.skill.flowVersion,
      now,
    ],
  );
  await database.execute(
    `INSERT INTO assistant_skill_usage
       (assistant_id, assistant_version, use_count, last_used_at, updated_at)
     VALUES ($1, $2, 1, $3, $3)
     ON CONFLICT(assistant_id, assistant_version) DO UPDATE SET
       use_count=assistant_skill_usage.use_count+1,
       last_used_at=excluded.last_used_at, updated_at=excluded.updated_at`,
    [input.skill.assistantId, input.skill.version, now],
  );
}

export async function finishAssistantSkillRun(
  id: string,
  input: {
    status: AssistantRunStatus;
    runtimeRunId?: string;
    assistantMessageId?: string;
    error?: unknown;
  },
  client?: DatabaseClient,
): Promise<void> {
  const database = client ?? await getDatabase();
  const [link] = await database.select<RunLinkRow[]>(
    "SELECT assistant_id, assistant_version, status FROM assistant_run_links WHERE id=$1",
    [id],
  );
  if (!link || link.status !== "running") return;
  const now = Date.now();
  await database.execute(
    `UPDATE assistant_run_links
        SET runtime_run_id=$2, assistant_message_id=$3, status=$4, error_json=$5,
            updated_at=$6, completed_at=$6
      WHERE id=$1 AND status='running'`,
    [
      id,
      input.runtimeRunId ?? null,
      input.assistantMessageId ?? null,
      input.status,
      input.error === undefined ? null : JSON.stringify({ message: errorMessage(input.error) }),
      now,
    ],
  );
  if (input.status === "succeeded") {
    await database.execute(
      `UPDATE assistant_skill_usage
          SET success_count=success_count+1, last_success_at=$3, updated_at=$3
        WHERE assistant_id=$1 AND assistant_version=$2`,
      [link.assistant_id, link.assistant_version, now],
    );
  } else if (input.status === "failed") {
    await database.execute(
      `UPDATE assistant_skill_usage
          SET failure_count=failure_count+1, last_failure_at=$3, updated_at=$3
        WHERE assistant_id=$1 AND assistant_version=$2`,
      [link.assistant_id, link.assistant_version, now],
    );
  }
}

export async function recoverInterruptedAssistantRuns(client?: DatabaseClient): Promise<number> {
  const database = client ?? await getDatabase();
  const now = Date.now();
  const result = await database.execute(
    `UPDATE assistant_run_links
        SET status='interrupted', error_json=$1, updated_at=$2, completed_at=$2
      WHERE status='running'`,
    [JSON.stringify({ message: "应用退出时运行尚未结束" }), now],
  );
  return result.rowsAffected;
}

function mapVersion(row: VersionRow): AssistantSkillVersion {
  return {
    assistantId: row.assistant_id,
    version: row.version,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    flowId: row.flow_id,
    flowVersion: row.flow_version,
    memoryNamespace: row.memory_namespace,
    capabilities: parseStringArray(row.capabilities_json),
    activationHints: parseStringArray(row.activation_hints_json),
    createdAt: row.created_at,
  };
}

function mapIndex(row: IndexRow): AssistantSkillIndex {
  return {
    assistantId: row.assistant_id,
    activeVersion: row.active_version,
    ...(row.previous_version ? { previousVersion: row.previous_version } : {}),
    name: row.name,
    description: row.description,
    flowId: row.flow_id,
    flowVersion: row.flow_version,
    capabilities: parseStringArray(row.capabilities_json),
    activationHints: parseStringArray(row.activation_hints_json),
    pinned: row.pinned === 1,
    archived: row.archived_at !== null,
    useCount: row.use_count,
    successCount: row.success_count,
    failureCount: row.failure_count,
    ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
    updatedAt: row.updated_at,
  };
}

function validateVersionInput(input: Omit<AssistantSkillVersion, "createdAt">): void {
  for (const [label, value] of [
    ["Assistant id", input.assistantId],
    ["Version", input.version],
    ["Name", input.name],
    ["System prompt", input.systemPrompt],
    ["Flow id", input.flowId],
    ["Flow version", input.flowVersion],
    ["Memory namespace", input.memoryNamespace],
  ] as const) {
    if (!value.trim()) throw new Error(`${label} is required`);
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(input.version)) {
    throw new Error("Assistant Skill version must use semantic versioning");
  }
  if (input.systemPrompt.length > 20_000) throw new Error("System prompt is too long");
}

function parseStringArray(json: string): string[] {
  const value = JSON.parse(json) as unknown;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
