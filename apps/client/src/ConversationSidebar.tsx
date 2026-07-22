import { useMemo, useState } from "react";
import type { AssistantSkillIndex } from "./assistantSkills";
import type { LocalConversation } from "./storage/repositories";

interface ConversationSidebarProps {
  conversations: LocalConversation[];
  skills: AssistantSkillIndex[];
  activeId?: string;
  unlocked: boolean;
  enabledModelCount: number;
  onCreateConversation: (assistantId?: string) => Promise<void>;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => Promise<void>;
  onOpenSettings: () => void;
}

export interface ConversationSkillSection {
  assistantId: string;
  name: string;
  conversations: LocalConversation[];
}

export function buildConversationSkillSections(
  conversations: LocalConversation[],
  skills: AssistantSkillIndex[],
): ConversationSkillSection[] {
  const known = new Map(skills.map((skill) => [skill.assistantId, skill.name]));
  for (const conversation of conversations) {
    const assistantId = conversation.assistantId ?? "builtin_assistant";
    if (!known.has(assistantId)) known.set(assistantId, assistantId);
  }
  return [...known.entries()].map(([assistantId, name]) => ({
    assistantId,
    name,
    conversations: conversations.filter(
      (conversation) => (conversation.assistantId ?? "builtin_assistant") === assistantId,
    ),
  })).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

export function ConversationSidebar(props: ConversationSidebarProps) {
  const [query, setQuery] = useState("");
  const [collapsedSkills, setCollapsedSkills] = useState<Set<string>>(new Set());
  const [deletingConversationId, setDeletingConversationId] = useState<string>();
  const [error, setError] = useState("");
  const sections = useMemo(
    () => buildConversationSkillSections(props.conversations, props.skills),
    [props.conversations, props.skills],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSections = sections.flatMap((section) => {
    const skillMatches = section.name.toLocaleLowerCase().includes(normalizedQuery);
    const conversations = normalizedQuery && !skillMatches
      ? section.conversations.filter((conversation) => conversation.title.toLocaleLowerCase().includes(normalizedQuery))
      : section.conversations;
    return normalizedQuery && !skillMatches && conversations.length === 0
      ? []
      : [{ ...section, conversations }];
  });

  function toggleSkill(id: string) {
    setCollapsedSkills((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function deleteConversation(id: string) {
    setError("");
    try {
      await props.onDeleteConversation(id);
      setDeletingConversationId(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <>
      <button className="new-chat-button" type="button" onClick={() => void props.onCreateConversation()}>
        <PlusIcon /><span>新对话</span><kbd>Ctrl N</kbd>
      </button>
      <div className="conversation-search">
        <SearchIcon />
        <input aria-label="搜索对话" placeholder="搜索 Skill 或对话" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        {query ? <button aria-label="清空搜索" type="button" onClick={() => setQuery("")}>×</button> : null}
      </div>
      {error ? <p className="conversation-sidebar-error" role="alert">{error}</p> : null}

      <nav aria-label="按 Skill 管理的会话列表" className="conversation-tree">
        {visibleSections.map((section) => {
          const collapsed = !normalizedQuery && collapsedSkills.has(section.assistantId);
          return (
            <section className="conversation-skill-section" key={section.assistantId}>
              <div className="conversation-skill-heading">
                <button aria-expanded={!collapsed} type="button" onClick={() => toggleSkill(section.assistantId)}>
                  <FolderIcon open={!collapsed} />
                  <span><strong>{section.name}</strong></span>
                </button>
                <button aria-label={`在 ${section.name} 下新建对话`} title="新建对话" type="button" onClick={() => void props.onCreateConversation(section.assistantId)}><PlusIcon /></button>
              </div>
              {!collapsed ? (
                <div className="conversation-skill-content skill-conversation-list">
                  {section.conversations.map((conversation) => (
                    <div className={`conversation-row ${conversation.id === props.activeId ? "active" : ""}`} key={conversation.id}>
                      {deletingConversationId === conversation.id ? (
                        <div className="delete-confirm">
                          <span>删除这条对话？</span>
                          <button type="button" onClick={() => setDeletingConversationId(undefined)}>取消</button>
                          <button className="danger" type="button" onClick={() => void deleteConversation(conversation.id)}>删除</button>
                        </div>
                      ) : (
                        <>
                          <button className="conversation-select" type="button" onClick={() => props.onSelectConversation(conversation.id)}>
                            <span><strong>{conversation.title || "新对话"}</strong></span>
                          </button>
                          <div className="conversation-row-actions">
                            <button aria-label={`删除 ${conversation.title || "新对话"}`} type="button" onClick={() => setDeletingConversationId(conversation.id)}><TrashIcon /></button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                  {section.conversations.length === 0 ? <p className="skill-conversation-empty">暂无对话</p> : null}
                </div>
              ) : null}
            </section>
          );
        })}
        {normalizedQuery && visibleSections.length === 0 ? <p className="conversation-search-empty">没有匹配的 Skill 或对话</p> : null}
      </nav>

      <div className="sidebar-footer">
        <button className="sidebar-settings-button" type="button" onClick={props.onOpenSettings}>
          <span className="footer-icon"><SettingsIcon /></span>
          <span><strong>设置</strong><small>{props.unlocked ? `${props.enabledModelCount} 个模型已启用` : "配置应用与模型"}</small></span>
          <ChevronRightIcon />
        </button>
        <div className="local-note"><ShieldIcon /> 对话与密钥仅保存在本机</div>
      </div>
    </>
  );
}

function Svg({ children }: { children: React.ReactNode }) { return <svg aria-hidden="true" viewBox="0 0 24 24">{children}</svg>; }
function PlusIcon() { return <Svg><path d="M12 5v14M5 12h14" /></Svg>; }
function SearchIcon() { return <Svg><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></Svg>; }
function TrashIcon() { return <Svg><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5M14 11v5" /></Svg>; }
function FolderIcon({ open }: { open: boolean }) {
  return open
    ? <Svg><path d="M3.5 8.5h6l2-2h3l2 2h4l-2 10h-15z" /><path d="M3.5 8.5V6h6l2 2" /></Svg>
    : <Svg><path d="M3 6h7l2 2h9v10H3z" /></Svg>;
}
function SettingsIcon() { return <Svg><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9A1.7 1.7 0 0 0 21 10h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></Svg>; }
function ShieldIcon() { return <Svg><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></Svg>; }
function ChevronRightIcon() { return <Svg><path d="m9 6 6 6-6 6" /></Svg>; }
