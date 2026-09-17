import { useCallback, useEffect, useState } from "react";
import {
  approveMemoryCandidate,
  deleteMemoryItem,
  listLearningCandidates,
  listMemoryItems,
  rejectLearningCandidate,
  setMemoryItemStatus,
  updateMemoryCandidateContent,
  updateMemoryItemContent,
  type LearningCandidate,
  type MemoryItem,
} from "./learningRepository";
import { listLearningJobs, type LearningJob } from "./learningJobs";
import type { ReflectionJobRunner } from "./reflectionRunner";

export function MemoryPanel({
  onClose,
  runner,
}: {
  onClose: () => void;
  runner?: ReflectionJobRunner;
}) {
  const [candidates, setCandidates] = useState<LearningCandidate[]>([]);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [jobs, setJobs] = useState<LearningJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [editingId, setEditingId] = useState<string>();
  const [editContent, setEditContent] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string>();
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [pending, stored, learningJobs] = await Promise.all([
      listLearningCandidates("pending"),
      listMemoryItems(),
      listLearningJobs(20),
    ]);
    setCandidates(pending);
    setMemories(stored);
    setJobs(learningJobs);
  }, []);

  useEffect(() => {
    let active = true;
    refresh()
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh]);

  useEffect(() => {
    if (!jobs.some((job) => job.status === "queued" || job.status === "running")) return;
    const interval = window.setInterval(() => { void refresh(); }, 1_200);
    return () => window.clearInterval(interval);
  }, [jobs, refresh]);

  async function perform(id: string, operation: () => Promise<void>) {
    setBusyId(id);
    setError("");
    try {
      await operation();
      await refresh();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(undefined);
    }
  }

  function beginEdit(memory: MemoryItem) {
    setEditingId(memory.id);
    setEditContent(memory.content);
    setPendingDeleteId(undefined);
  }

  return (
    <div className="memory-content">
      <header className="settings-header">
        <div>
          <span className="settings-kicker">LOCAL LEARNING</span>
          <h2>本地记忆</h2>
          <p>自动归档会启用通过安全检查的稳定事实；所有记忆都可停用、修改或删除。</p>
        </div>
        <button aria-label="关闭本地记忆" className="icon-button" type="button" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>

      {error ? <p className="form-message error" role="alert">{error}</p> : null}
      {loading ? <div className="memory-loading">正在读取本地记忆…</div> : (
        <>
          <section className="memory-section">
            <div className="memory-section-heading">
              <div><h3>记忆归档任务</h3><p>自动归档每轮问答，也可分析负反馈；挂起或退出后可以安全继续。</p></div>
              <span>{jobs.filter((job) => job.status === "running" || job.status === "queued").length} 进行中</span>
            </div>
            {jobs.length === 0 ? (
              <div className="memory-empty">对回复点踩并填写纠正后，可以创建本地反思任务。</div>
            ) : (
              <div className="learning-job-list">
                {jobs.map((job) => (
                  <article className={`learning-job ${job.status}`} key={job.id}>
                    <span className="learning-job-status">{jobStatusLabel(job.status)}</span>
                    <div>
                      <strong>{job.mode === "auto_archive" ? "自动归档" : "反馈反思"}</strong>
                      <small>{jobSummary(job)} · 尝试 {job.attempt} 次</small>
                    </div>
                    <div className="learning-job-actions">
                      {job.status === "queued" ? <button disabled={!runner || busyId === job.id} type="button" onClick={() => runner && void perform(job.id, async () => { await runner.run(job.id); })}>开始</button> : null}
                      {job.status === "running" ? <button className="danger" disabled={!runner} type="button" onClick={() => runner && void perform(job.id, async () => { await runner.cancel(job.id); })}>取消</button> : null}
                      {job.status === "failed" || job.status === "interrupted" ? <button disabled={!runner || busyId === job.id} type="button" onClick={() => runner && void perform(job.id, async () => { await runner.retry(job.id); })}>继续</button> : null}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="memory-section">
            <div className="memory-section-heading">
              <div><h3>待你确认</h3><p>候选不会自动进入聊天上下文。</p></div>
              <span>{candidates.length}</span>
            </div>
            {candidates.length === 0 ? (
              <div className="memory-empty">在聊天消息下点击“记住”，候选会先出现在这里。</div>
            ) : (
              <div className="memory-list">
                {candidates.map((candidate) => (
                  <article className="memory-card candidate" key={candidate.id}>
                    <div className="memory-card-meta"><span>事实候选</span><small>{formatDate(candidate.createdAt)}</small></div>
                    {editingId === candidate.id ? (
                      <textarea aria-label="编辑事实候选" autoFocus value={editContent} onChange={(event) => setEditContent(event.currentTarget.value)} />
                    ) : <p>{candidate.proposal.content}</p>}
                    <small className="memory-rationale">{candidate.rationale}</small>
                    <div className="memory-card-actions">
                      {editingId === candidate.id ? (
                        <>
                          <button type="button" onClick={() => setEditingId(undefined)}>取消</button>
                          <button className="approve" disabled={!editContent.trim() || busyId === candidate.id} type="button" onClick={() => void perform(candidate.id, async () => { await updateMemoryCandidateContent(candidate.id, editContent); setEditingId(undefined); })}>保存候选</button>
                        </>
                      ) : (
                        <>
                          <button type="button" onClick={() => void perform(candidate.id, async () => { await rejectLearningCandidate(candidate.id); })}>拒绝</button>
                          <button type="button" onClick={() => { setEditingId(candidate.id); setEditContent(candidate.proposal.content); }}>编辑</button>
                          <button className="approve" disabled={busyId === candidate.id} type="button" onClick={() => void perform(candidate.id, async () => { await approveMemoryCandidate(candidate.id); })}>批准并启用</button>
                        </>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="memory-section">
            <div className="memory-section-heading">
              <div><h3>已保存记忆</h3><p>相关记忆会在本地检索后注入聊天 Flow。</p></div>
              <span>{memories.filter((memory) => memory.status === "active").length} 启用</span>
            </div>
            {memories.length === 0 ? <div className="memory-empty">还没有已保存的长期记忆。</div> : (
              <div className="memory-list">
                {memories.map((memory) => (
                  <article className={`memory-card ${memory.status}`} key={memory.id}>
                    <div className="memory-card-meta">
                      <span>{memory.status === "active" ? "已启用" : "已停用"}</span>
                      <small>{formatDate(memory.updatedAt)}</small>
                    </div>
                    {editingId === memory.id ? (
                      <textarea aria-label="编辑记忆内容" autoFocus value={editContent} onChange={(event) => setEditContent(event.currentTarget.value)} />
                    ) : <p>{memory.content}</p>}
                    <div className="memory-card-actions">
                      {pendingDeleteId === memory.id ? (
                        <>
                          <span className="memory-delete-question">确认永久删除？</span>
                          <button type="button" onClick={() => setPendingDeleteId(undefined)}>取消</button>
                          <button className="danger" type="button" onClick={() => void perform(memory.id, async () => { await deleteMemoryItem(memory.id); setPendingDeleteId(undefined); })}>删除</button>
                        </>
                      ) : editingId === memory.id ? (
                        <>
                          <button type="button" onClick={() => setEditingId(undefined)}>取消</button>
                          <button className="approve" disabled={!editContent.trim() || busyId === memory.id} type="button" onClick={() => void perform(memory.id, async () => { await updateMemoryItemContent(memory.id, editContent); setEditingId(undefined); })}>保存</button>
                        </>
                      ) : (
                        <>
                          <button type="button" onClick={() => setPendingDeleteId(memory.id)}>删除</button>
                          <button type="button" onClick={() => beginEdit(memory)}>编辑</button>
                          <button className={memory.status === "active" ? "" : "approve"} type="button" onClick={() => void perform(memory.id, async () => { await setMemoryItemStatus(memory.id, memory.status === "active" ? "disabled" : "active"); })}>{memory.status === "active" ? "停用" : "启用"}</button>
                        </>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
      <p className="memory-privacy-note">每次成功问答默认都会由当前模型异步提取稳定事实并自动归档，本地记忆正文与向量保存在当前设备的 SQLite 数据库中。语义检索默认由本机 BGE 完成；只有切换到云端 Embeddings 时，查询和待索引记忆才会额外发送给所选 Provider。启用 MemOS 后还会按其配置进行跨端召回与写入。</p>
    </div>
  );
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function jobStatusLabel(status: LearningJob["status"]): string {
  if (status === "queued") return "等待";
  if (status === "running") return "分析中";
  if (status === "succeeded") return "已完成";
  if (status === "failed") return "失败";
  if (status === "interrupted") return "可继续";
  return "已取消";
}

function jobSummary(job: LearningJob): string {
  if (job.status === "succeeded") {
    const count = job.mode === "auto_archive" && typeof job.result?.approvedCount === "number"
      ? job.result.approvedCount
      : typeof job.result?.proposedCount === "number" ? job.result.proposedCount : 0;
    return job.mode === "auto_archive" ? `${count} 条已归档` : `${count} 条候选`;
  }
  if (job.error?.message) return job.error.message;
  return formatDate(job.updatedAt);
}

function CloseIcon() {
  return <svg aria-hidden viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}
