import { useCallback, useEffect, useState } from "react";
import {
  listAssistantSkillIndex,
  rollbackAssistantSkill,
  setAssistantSkillArchived,
  setAssistantSkillPinned,
  type AssistantSkillIndex,
} from "./assistantSkills";

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
  const [skills, setSkills] = useState<AssistantSkillIndex[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState("");

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

  async function perform(assistantId: string, action: () => Promise<void>) {
    setBusyId(assistantId);
    setError("");
    try {
      await action();
      await refresh();
      await onChanged();
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    } finally {
      setBusyId(undefined);
    }
  }

  const activeCount = skills.filter((skill) => !skill.archived).length;
  return (
    <div className="skill-content">
      <header className="settings-header">
        <div>
          <span className="settings-kicker">FLOW AS SKILL</span>
          <h2>助手技能</h2>
          <p>每个助手版本固定绑定 Prompt、Flow、记忆空间和能力；已有对话不会被热切换。</p>
        </div>
        <button aria-label="关闭助手技能" className="icon-button" type="button" onClick={onClose}><CloseIcon /></button>
      </header>
      {error ? <p className="form-message error" role="alert">{error}</p> : null}
      {selectionLocked ? <p className="skill-lock-note">当前对话已有消息。切换只允许在空对话中进行；版本发布和回滚只影响之后的新对话。</p> : null}
      {loading ? <div className="memory-loading">正在读取本地 Skill 索引…</div> : (
        <div className="skill-list">
          {skills.map((skill) => {
            const selected = skill.assistantId === selectedAssistantId
              && skill.activeVersion === selectedVersion;
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
      <p className="memory-privacy-note">这里只加载紧凑 Skill 索引；完整 System Prompt 仅在会话实际选择该版本时读取。</p>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function CloseIcon() {
  return <svg aria-hidden viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}
