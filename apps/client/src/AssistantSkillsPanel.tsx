import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listAssistantSkillIndex,
  promoteAssistantSkillVersion,
  publishAssistantSkillVersion,
  rollbackAssistantSkill,
  setAssistantSkillArchived,
  setAssistantSkillPinned,
  type AssistantSkillIndex,
} from "./assistantSkills";
import { BUILTIN_CHAT_FLOW_ID, BUILTIN_CHAT_FLOW_VERSION } from "./builtinFlows";
import { MARKET_MCP_TEMPLATES, MARKET_SKILLS, type MarketSkill } from "./capabilityMarket";
import {
  loadMcpServers,
  removeMcpServer,
  saveMcpServers,
  upsertMcpServer,
  type McpServerConfig,
  type McpServerInput,
} from "./mcpConfig";

type CapabilityTab = "skills" | "mcp" | "market";

const EMPTY_MCP: McpServerInput = {
  id: "",
  name: "",
  description: "",
  endpoint: "http://127.0.0.1:8000/mcp",
  transport: "streamable-http",
  authHeaderRef: "",
  enabled: false,
};

const EMPTY_SKILL = {
  assistantId: "",
  name: "",
  description: "",
  systemPrompt: "",
  activationHints: "",
  capabilities: "network.http, secret.read",
};

export function AssistantSkillsPanel({
  onClose,
  onSelect,
  onChanged,
  selectedAssistantId,
  selectedVersion,
  selectionLocked,
}: {
  onClose: () => void;
  onSelect: (skill: AssistantSkillIndex) => Promise<void>;
  onChanged: () => Promise<void>;
  selectedAssistantId?: string;
  selectedVersion?: string;
  selectionLocked: boolean;
}) {
  const [tab, setTab] = useState<CapabilityTab>("skills");
  const [skills, setSkills] = useState<AssistantSkillIndex[]>([]);
  const [servers, setServers] = useState<McpServerConfig[]>(() => loadMcpServers());
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [skillFormOpen, setSkillFormOpen] = useState(false);
  const [skillDraft, setSkillDraft] = useState(EMPTY_SKILL);
  const [mcpDraft, setMcpDraft] = useState<McpServerInput>();
  const [marketQuery, setMarketQuery] = useState("");

  const refresh = useCallback(async () => {
    setSkills(await listAssistantSkillIndex({ includeArchived: true }));
  }, []);

  useEffect(() => {
    let active = true;
    refresh()
      .catch((cause: unknown) => { if (active) setError(errorMessage(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh]);

  async function perform(id: string, action: () => Promise<void>, message?: string) {
    setBusyId(id);
    setError("");
    setNotice("");
    try {
      await action();
      await refresh();
      await onChanged();
      if (message) setNotice(message);
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    } finally {
      setBusyId(undefined);
    }
  }

  function commitServers(next: McpServerConfig[], message: string) {
    try {
      saveMcpServers(next);
      setServers(next);
      setMcpDraft(undefined);
      setError("");
      setNotice(message);
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    }
  }

  async function createSkill() {
    const id = skillDraft.assistantId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
    await perform(id || "new-skill", async () => {
      await publishAssistantSkillVersion({
        assistantId: id,
        version: "1.0.0",
        name: skillDraft.name,
        description: skillDraft.description,
        systemPrompt: skillDraft.systemPrompt,
        flowId: BUILTIN_CHAT_FLOW_ID,
        flowVersion: BUILTIN_CHAT_FLOW_VERSION,
        memoryNamespace: `skill_${id}`,
        capabilities: splitList(skillDraft.capabilities),
        activationHints: splitList(skillDraft.activationHints),
      });
      await promoteAssistantSkillVersion(id, "1.0.0");
      setSkillDraft(EMPTY_SKILL);
      setSkillFormOpen(false);
    }, `已创建 ${skillDraft.name.trim()} Skill`);
  }

  async function installSkill(skill: MarketSkill) {
    if (skills.some((item) => item.assistantId === skill.assistantId)) {
      setNotice(`${skill.name} 已安装`);
      return;
    }
    await perform(skill.assistantId, async () => {
      const { category: _category, featured: _featured, ...definition } = skill;
      await publishAssistantSkillVersion(definition);
      await promoteAssistantSkillVersion(skill.assistantId, skill.version);
    }, `已安装 ${skill.name}`);
  }

  const activeCount = skills.filter((skill) => !skill.archived).length;
  const installedSkillIds = useMemo(() => new Set(skills.map((skill) => skill.assistantId)), [skills]);
  const normalizedQuery = marketQuery.trim().toLocaleLowerCase();
  const marketSkills = MARKET_SKILLS.filter((item) => marketMatches(item, normalizedQuery));
  const marketServers = MARKET_MCP_TEMPLATES.filter((item) => marketMatches(item, normalizedQuery));

  return (
    <div className="skill-content capability-center">
      <header className="settings-header capability-header">
        <div>
          <span className="settings-kicker">TOOLS &amp; SKILLS</span>
          <h2>能力中心</h2>
          <p>管理本地 Skill、MCP 连接与可安装模板。连接凭据只保存 Stronghold 引用。</p>
        </div>
        <button aria-label="关闭能力中心" className="icon-button" type="button" onClick={onClose}><CloseIcon /></button>
      </header>

      <nav aria-label="能力中心页面" className="capability-tabs">
        <TabButton active={tab === "skills"} count={skills.filter((skill) => !skill.archived).length} label="Skills" onClick={() => setTab("skills")} />
        <TabButton active={tab === "mcp"} count={servers.length} label="MCP" onClick={() => setTab("mcp")} />
        <TabButton active={tab === "market"} label="市场" onClick={() => setTab("market")} />
      </nav>

      {error ? <p className="form-message error capability-message" role="alert">{error}</p> : null}
      {notice ? <p className="form-message success capability-message" role="status">{notice}</p> : null}

      {tab === "skills" ? (
        <section className="capability-panel" aria-label="Skills 管理">
          <div className="capability-toolbar">
            <div><strong>本地 Skills</strong><small>绑定 Prompt、Flow、记忆空间与能力权限</small></div>
            <button className="primary-compact" type="button" onClick={() => setSkillFormOpen((value) => !value)}>{skillFormOpen ? "收起" : "+ 创建 Skill"}</button>
          </div>
          {selectionLocked ? <p className="skill-lock-note">当前对话已有消息。切换只允许在空对话中进行；版本变更只影响之后的新对话。</p> : null}
          {skillFormOpen ? (
            <form className="capability-form" onSubmit={(event) => { event.preventDefault(); void createSkill(); }}>
              <div className="capability-form-heading"><strong>创建本地 Skill</strong><small>首版固定为 1.0.0，并绑定通用聊天 Flow。</small></div>
              <div className="capability-form-grid">
                <Field label="标识"><input required placeholder="research_helper" value={skillDraft.assistantId} onChange={(event) => setSkillDraft({ ...skillDraft, assistantId: event.currentTarget.value })} /></Field>
                <Field label="名称"><input required placeholder="研究助手" value={skillDraft.name} onChange={(event) => setSkillDraft({ ...skillDraft, name: event.currentTarget.value })} /></Field>
              </div>
              <Field label="简介"><input required placeholder="一句话说明适用场景" value={skillDraft.description} onChange={(event) => setSkillDraft({ ...skillDraft, description: event.currentTarget.value })} /></Field>
              <Field label="系统提示词"><textarea required rows={5} placeholder="定义角色、工作边界和输出要求…" value={skillDraft.systemPrompt} onChange={(event) => setSkillDraft({ ...skillDraft, systemPrompt: event.currentTarget.value })} /></Field>
              <div className="capability-form-grid">
                <Field label="触发提示"><input placeholder="研究, 总结, 对比" value={skillDraft.activationHints} onChange={(event) => setSkillDraft({ ...skillDraft, activationHints: event.currentTarget.value })} /></Field>
                <Field label="能力权限"><input placeholder="network.http, secret.read" value={skillDraft.capabilities} onChange={(event) => setSkillDraft({ ...skillDraft, capabilities: event.currentTarget.value })} /></Field>
              </div>
              <div className="capability-form-actions"><button type="button" onClick={() => setSkillFormOpen(false)}>取消</button><button className="approve" disabled={Boolean(busyId)} type="submit">创建 Skill</button></div>
            </form>
          ) : null}
          {loading ? <div className="memory-loading">正在读取本地 Skill 索引…</div> : (
            <div className="skill-list">
              {skills.map((skill) => {
                const selected = skill.assistantId === selectedAssistantId && skill.activeVersion === selectedVersion;
                return (
                  <article className={`skill-card ${selected ? "selected" : ""} ${skill.archived ? "archived" : ""}`} key={skill.assistantId}>
                    <div className="skill-card-heading">
                      <span className="assistant-avatar">{skill.name.slice(0, 1).toUpperCase()}</span>
                      <div><strong>{skill.name}</strong><small>{skill.description || "本地 Assistant Skill"}</small></div>
                      {skill.pinned ? <span className="skill-badge">已固定</span> : null}
                      {skill.archived ? <span className="skill-badge archived">已归档</span> : null}
                    </div>
                    <dl className="skill-details">
                      <div><dt>Assistant</dt><dd>{skill.assistantId}@{skill.activeVersion}</dd></div>
                      <div><dt>Flow</dt><dd>{skill.flowId}@{skill.flowVersion}</dd></div>
                      <div><dt>使用效果</dt><dd>{skill.useCount} 次 · {skill.successCount} 成功 · {skill.failureCount} 失败</dd></div>
                    </dl>
                    <div className="skill-chips">
                      {skill.activationHints.map((hint) => <span key={hint}>{hint}</span>)}
                      {skill.capabilities.map((capability) => <span className="capability" key={capability}>{capability}</span>)}
                    </div>
                    <div className="skill-card-actions">
                      <button type="button" onClick={() => void perform(skill.assistantId, async () => { await setAssistantSkillPinned(skill.assistantId, !skill.pinned); })}>{skill.pinned ? "取消固定" : "固定"}</button>
                      {skill.previousVersion ? <button type="button" onClick={() => void perform(skill.assistantId, async () => { await rollbackAssistantSkill(skill.assistantId); })}>回滚到 {skill.previousVersion}</button> : null}
                      <button disabled={!skill.archived && activeCount <= 1} type="button" onClick={() => void perform(skill.assistantId, async () => { await setAssistantSkillArchived(skill.assistantId, !skill.archived); })}>{skill.archived ? "恢复" : "归档"}</button>
                      <button className="approve" disabled={skill.archived || selectionLocked || selected || busyId === skill.assistantId} type="button" onClick={() => void perform(skill.assistantId, async () => { await onSelect(skill); })}>{selected ? "当前会话" : "用于当前会话"}</button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {tab === "mcp" ? (
        <section className="capability-panel" aria-label="MCP 配置">
          <div className="capability-toolbar">
            <div><strong>MCP 连接</strong><small>支持 Streamable HTTP 与兼容 SSE 传输</small></div>
            <button className="primary-compact" type="button" onClick={() => setMcpDraft(EMPTY_MCP)}>+ 添加 MCP</button>
          </div>
          <p className="capability-security-note"><ShieldIcon /> 这里只保存连接元数据与密钥引用；令牌请存入设备 Stronghold。</p>
          {mcpDraft ? <McpEditor draft={mcpDraft} onCancel={() => setMcpDraft(undefined)} onChange={setMcpDraft} onSave={() => commitServers(upsertMcpServer(servers, mcpDraft), `已保存 ${mcpDraft.name.trim()} 连接`)} /> : null}
          <div className="mcp-list">
            {servers.length ? servers.map((server) => (
              <article className="mcp-card" key={server.id}>
                <span className={`mcp-status ${server.enabled ? "enabled" : ""}`} />
                <div className="mcp-card-main"><strong>{server.name}</strong><small>{server.description || "自定义 MCP Server"}</small><code>{server.endpoint}</code></div>
                <div className="mcp-card-meta"><span>{server.transport === "streamable-http" ? "HTTP" : "SSE"}</span>{server.authHeaderRef ? <span>密钥引用</span> : <span>无认证</span>}</div>
                <div className="mcp-card-actions">
                  <button type="button" onClick={() => setMcpDraft(server)}>编辑</button>
                  <button type="button" onClick={() => commitServers(upsertMcpServer(servers, { ...server, enabled: !server.enabled }), `${server.name} 已${server.enabled ? "停用" : "启用"}`)}>{server.enabled ? "停用" : "启用"}</button>
                  <button className="danger" type="button" onClick={() => commitServers(removeMcpServer(servers, server.id), `已移除 ${server.name}`)}>移除</button>
                </div>
              </article>
            )) : <div className="capability-empty"><McpIcon /><strong>还没有 MCP 连接</strong><small>添加自定义 Server，或从市场安装连接模板。</small><button type="button" onClick={() => setTab("market")}>浏览市场</button></div>}
          </div>
        </section>
      ) : null}

      {tab === "market" ? (
        <section className="capability-panel market-panel" aria-label="能力市场">
          <div className="market-hero"><span>DISCOVER</span><h3>扩展你的本地助手</h3><p>从经过整理的模板开始，再按实际权限和服务地址完成配置。</p><label><SearchIcon /><input aria-label="搜索市场" placeholder="搜索 Skill 或 MCP…" value={marketQuery} onChange={(event) => setMarketQuery(event.currentTarget.value)} /></label></div>
          <div className="market-section-heading"><div><strong>Skills</strong><small>可编辑的 Prompt + Flow 模板</small></div><span>{marketSkills.length}</span></div>
          <div className="market-grid">
            {marketSkills.map((skill) => <MarketCard action={installedSkillIds.has(skill.assistantId) ? "已安装" : "安装"} busy={busyId === skill.assistantId} description={skill.description} featured={skill.featured} key={skill.assistantId} meta={`${skill.category} · v${skill.version}`} name={skill.name} onInstall={() => void installSkill(skill)} tags={skill.activationHints} />)}
          </div>
          <div className="market-section-heading"><div><strong>MCP Servers</strong><small>安装后需核对地址、认证和权限</small></div><span>{marketServers.length}</span></div>
          <div className="market-grid">
            {marketServers.map((template) => {
              const installed = servers.some((server) => server.id === template.id);
              return <MarketCard action={installed ? "已添加" : "添加配置"} description={template.description} featured={template.featured} key={template.id} meta={`${template.category} · ${template.transport === "streamable-http" ? "HTTP" : "SSE"}`} name={template.name} onInstall={() => {
                if (installed) return;
                const { category: _category, featured: _featured, ...input } = template;
                commitServers(upsertMcpServer(servers, input), `已添加 ${template.name} 配置，请核对地址后启用`);
              }} tags={[new URL(template.endpoint).host]} />;
            })}
          </div>
          {!marketSkills.length && !marketServers.length ? <div className="capability-empty"><SearchIcon /><strong>没有匹配的能力</strong><small>换一个名称、分类或用途关键词试试。</small></div> : null}
        </section>
      ) : null}
    </div>
  );
}

function TabButton({ active, count, label, onClick }: { active: boolean; count?: number; label: string; onClick: () => void }) {
  return <button aria-selected={active} className={active ? "active" : ""} role="tab" type="button" onClick={onClick}><span>{label}</span>{count === undefined ? null : <small>{count}</small>}</button>;
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
  return <label className="capability-field"><span>{label}</span>{children}</label>;
}

function McpEditor({ draft, onCancel, onChange, onSave }: { draft: McpServerInput; onCancel: () => void; onChange: (draft: McpServerInput) => void; onSave: () => void }) {
  return (
    <form className="capability-form mcp-editor" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <div className="capability-form-heading"><strong>连接设置</strong><small>推荐使用 Streamable HTTP；旧服务可选择 SSE。</small></div>
      <div className="capability-form-grid">
        <Field label="标识"><input required placeholder="context-server" value={draft.id} onChange={(event) => onChange({ ...draft, id: event.currentTarget.value })} /></Field>
        <Field label="名称"><input required placeholder="Context Server" value={draft.name} onChange={(event) => onChange({ ...draft, name: event.currentTarget.value })} /></Field>
      </div>
      <Field label="服务地址"><input required inputMode="url" placeholder="https://example.com/mcp" value={draft.endpoint} onChange={(event) => onChange({ ...draft, endpoint: event.currentTarget.value })} /></Field>
      <div className="capability-form-grid">
        <Field label="传输"><select value={draft.transport} onChange={(event) => onChange({ ...draft, transport: event.currentTarget.value as McpServerInput["transport"] })}><option value="streamable-http">Streamable HTTP</option><option value="sse">SSE（兼容）</option></select></Field>
        <Field label="认证密钥引用"><input placeholder="stronghold:mcp/context" value={draft.authHeaderRef} onChange={(event) => onChange({ ...draft, authHeaderRef: event.currentTarget.value })} /></Field>
      </div>
      <Field label="说明"><input placeholder="这个 Server 提供什么工具" value={draft.description} onChange={(event) => onChange({ ...draft, description: event.currentTarget.value })} /></Field>
      <label className="capability-switch"><input checked={draft.enabled} type="checkbox" onChange={(event) => onChange({ ...draft, enabled: event.currentTarget.checked })} /><span /><div><strong>启用连接</strong><small>仅在确认服务来源和工具权限后开启</small></div></label>
      <div className="capability-form-actions"><button type="button" onClick={onCancel}>取消</button><button className="approve" type="submit">保存连接</button></div>
    </form>
  );
}

function MarketCard({ action, busy, description, featured, meta, name, onInstall, tags }: { action: string; busy?: boolean; description: string; featured?: boolean; meta: string; name: string; onInstall: () => void; tags: string[] }) {
  const installed = action === "已安装" || action === "已添加";
  return <article className="market-card"><div className="market-card-top"><span className="market-avatar">{name.slice(0, 1).toUpperCase()}</span><div><strong>{name}</strong><small>{meta}</small></div>{featured ? <b>精选</b> : null}</div><p>{description}</p><div className="market-tags">{tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}</div><button className={installed ? "installed" : ""} disabled={installed || busy} type="button" onClick={onInstall}>{busy ? "安装中…" : action}</button></article>;
}

function marketMatches(item: { name: string; description: string; category: string }, query: string): boolean {
  if (!query) return true;
  return `${item.name} ${item.description} ${item.category}`.toLocaleLowerCase().includes(query);
}

function splitList(value: string): string[] {
  return [...new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function CloseIcon() { return <svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>; }
function ShieldIcon() { return <svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></svg>; }
function SearchIcon() { return <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>; }
function McpIcon() { return <svg viewBox="0 0 24 24"><circle cx="7" cy="7" r="3" /><circle cx="17" cy="17" r="3" /><path d="m9 9 6 6M14 6h4v4M10 18H6v-4" /></svg>; }
