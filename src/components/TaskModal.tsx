"use client";
import Link from "next/link";
import { useState } from "react";
import { PRIORITY, ROLE, api, dueLabel, useGet } from "@/components/api";
import { fitBlockedReason } from "@/components/blocked-reason";
import { Confirm, Modal, Skeleton } from "@/components/ui";
import { ConvertDialog } from "@/components/ConvertDialog";
import { TaskLinks } from "@/components/TaskLinks";
import { Comments } from "@/components/Comments";
import { useMe } from "@/app/(app)/Shell";

type P = { id: string; name: string };
type Sub = { id: string; title: string; completedAt: string | null; canClose: boolean; updatedAt: string };
type Task = {
  id: string; projectId: string; parentId: string | null; createdById: string; title: string; description: string | null; priority: string;
  dueDate: string | null; blocked: boolean; blockedReason: string | null; completedAt: string | null; isIdea?: boolean;
  assignee: P; approver: P | null; collaborators: P[]; awaitingApproval: boolean; updatedAt: string; canClose: boolean;
  section: { id: string; name: string; isDone: boolean }; project: { id: string; name: string; archived: boolean };
  subtaskList: Sub[];
  links?: { id: string; organisation: { id: string; name: string } | null; contact: { id: string; name: string; organisationId: string } | null }[];
  commentsEnabled?: boolean;
};
type Project = {
  id: string; role: string; type?: "PROJECT" | "DEAL"; archived: boolean; sections: { id: string; name: string; isDone: boolean }[];
  members: { userId: string; name: string; role: string; active: boolean }[];
};

export function TaskModal({ id, me, onClose, onChanged, asPage }: { id: string; me: string; onClose: () => void; onChanged?: () => void; asPage?: boolean }) {
  const t = useGet<{ task: Task }>(`/api/tasks/${id}`);
  const task = t.data?.task;
  const pr = useGet<{ project: Project }>(task ? `/api/projects/${task.projectId}` : null);
  const [err, setErr] = useState<string | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [lost, setLost] = useState<Record<string, unknown> | null>(null); // the edit that was refused as stale, so it can be re-applied
  const [confirm, setConfirm] = useState<null | { kind: "complete" | "move"; n: number; sectionId?: string }>(null);
  const [trash, setTrash] = useState(false);
  const [newSub, setNewSub] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [convert, setConvert] = useState(false);
  const meCtx = useMe();

  const body = (inner: React.ReactNode) => (asPage ? <div className="modal" style={{ margin: "0 auto" }}>{inner}</div> : <Modal label="Task" onClose={onClose}>{inner}</Modal>);

  if (t.loading) return body(<Skeleton />);
  if (!task) {
    return body(
      <>
        <h2>This task isn&apos;t available</h2>
        <p className="sub">It may have been moved to Trash, or you may not be a member of its project.</p>
        <div className="actions"><Link className="btn" href="/">Go to My tasks</Link></div>
      </>,
    );
  }
  const project = pr.data?.project;
  const role = project?.role ?? "VIEWER";
  const canEdit = role !== "VIEWER" && !task.project.archived;
  const holding = task.awaitingApproval && task.approver?.id === me && role !== "LEADER";
  const canManage = role === "LEADER";
  const workers = project?.members.filter((m) => m.active && (m.role === "LEADER" || m.role === "EDITOR")) ?? [];
  const everyone = project?.members.filter((m) => m.active) ?? [];
  const done = !!task.completedAt;
  const version = task.updatedAt; // APL-2668: every change is made on the version the modal shows

  async function run(r: Promise<{ ok: boolean; status: number; error?: string; data: Record<string, any> }>, after?: () => void) { // eslint-disable-line @typescript-eslint/no-explicit-any
    setBusy(true);
    const res = await r;
    setBusy(false);
    if (res.ok) {
      setErr(null); setStale(null); setLost(null); after?.(); t.reload(); onChanged?.();
      return res;
    }
    if (res.status === 409 && res.data.stale) {
      setStale(`${res.data.changedBy ?? "Someone"} changed this task while you were editing. Your change was not saved; the fields now show the current values.`);
      t.reload();
    } else if (res.status === 409 && res.data.needsConfirm === "open_subtasks") {
      return res;
    } else setErr(res.error ?? "Something went wrong.");
    return res;
  }
  const save = async (patch: Record<string, unknown>) => {
    const res = await run(api("PATCH", `/api/tasks/${id}`, { ...patch, expectedUpdatedAt: task.updatedAt }));
    if (res && !res.ok && res.status === 409 && res.data.stale) setLost(patch);
    return res;
  };
  const LABEL: Record<string, string> = { title: "Title", description: "Description", dueDate: "Due date", priority: "Priority", blocked: "Blocked", blockedReason: "Blocked reason" };
  const describe = (patch: Record<string, unknown>) =>
    Object.entries(patch).filter(([k]) => LABEL[k]).map(([k, v]) => `${LABEL[k]}: ${v === null || v === "" ? "(cleared)" : typeof v === "boolean" ? (v ? "Yes" : "No") : k === "priority" ? PRIORITY[String(v)] ?? String(v) : `"${String(v)}"`}`).join(", ");

  async function complete(all = false) {
    const res = await run(api("POST", `/api/tasks/${id}/complete`, { completeAll: all, expectedUpdatedAt: version }), () => setConfirm(null));
    if (res && !res.ok && res.status === 409 && res.data.needsConfirm === "open_subtasks") setConfirm({ kind: "complete", n: res.data.openSubtasks });
  }
  async function move(sectionId: string, all = false) {
    const res = await run(api("POST", `/api/tasks/${id}/move`, { sectionId, completeAll: all, expectedUpdatedAt: version }), () => setConfirm(null));
    if (res && !res.ok && res.status === 409 && res.data.needsConfirm === "open_subtasks") setConfirm({ kind: "move", n: res.data.openSubtasks, sectionId });
  }

  return (
    <>
      {body(
        <>
          <div className="bar">
            <span>{task.parentId ? "Subtask · " : ""}<Link href={`/projects/${task.project.id}`}>{task.project.name}</Link> · {task.section.name}</span>
            <span>
              <button className="link" onClick={async () => { try { await navigator.clipboard.writeText(`${location.origin}/tasks/${id}`); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setErr("Could not copy. The link is " + location.origin + "/tasks/" + id); } }}>{copied ? "Copied" : "Copy link"}</button>
              {" · "}<button className="link" onClick={onClose}>Close</button>
            </span>
          </div>
          {task.project.archived && <div className="box warn">This project is archived and read-only.</div>}
          {stale && (
            <div className="box warn" role="alert">
              {stale}
              {lost && describe(lost) && (
                <div style={{ marginTop: 6 }}>
                  Your edit was: {describe(lost)}.{" "}
                  <button className="link" disabled={busy} onClick={() => save(lost)}>Re-apply my edit</button>
                  {" · "}<button className="link" onClick={() => { setStale(null); setLost(null); }}>Dismiss</button>
                </div>
              )}
            </div>
          )}
          {err && <div className="err" role="alert">{err}</div>}
          <textarea className="tt" rows={1} aria-label="Title" defaultValue={task.title} key={task.title + task.updatedAt} readOnly={!canEdit || holding} maxLength={500}
            ref={(el) => { if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } }}
            onInput={(e) => { const el = e.currentTarget; el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (!v) { setErr("Give the task a title."); e.target.value = task.title; }
              else if (v !== task.title) save({ title: v });
              else e.target.value = task.title;
            }} />
          {task.awaitingApproval && (
            <div className="box warn">Waiting for <b>{task.approver?.name}</b> to approve this task.</div>
          )}
          <div className="fgrid">
            <span className="lbl">Assignee</span>
            <div>
              {canEdit && !holding ? (
                <select className="in" aria-label="Assignee" value={task.assignee.id} disabled={busy}
                  onChange={(e) => run(api("POST", `/api/tasks/${id}/assign`, { assigneeId: e.target.value, expectedUpdatedAt: version }))}>
                  {!workers.some((w) => w.userId === task.assignee.id) && <option value={task.assignee.id}>{task.assignee.name}</option>}
                  {workers.map((w) => <option key={w.userId} value={w.userId}>{w.name}</option>)}
                </select>
              ) : task.assignee.name}
            </div>
            <span className="lbl">Collaborators</span>
            <div className="pills">
              {task.collaborators.map((c) => (
                <span className="chip" key={c.id}>{c.name}{canEdit && !holding && (
                  <button className="link" style={{ marginLeft: 6, textDecoration: "none" }} aria-label={`Remove ${c.name}`} onClick={() => run(api("DELETE", `/api/tasks/${id}/collaborators/${c.id}`))}>×</button>
                )}</span>
              ))}
              {!task.collaborators.length && !canEdit && <span className="hint">None</span>}
              {canEdit && !holding && (
                <select className="in" style={{ width: "auto" }} aria-label="Add a collaborator" value="" disabled={busy}
                  onChange={(e) => e.target.value && run(api("POST", `/api/tasks/${id}/collaborators`, { userId: e.target.value }))}>
                  <option value="">+ Add</option>
                  {everyone.filter((m) => m.userId !== task.assignee.id && !task.collaborators.some((c) => c.id === m.userId)).map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
                </select>
              )}
            </div>
            <span className="lbl">Approver</span>
            <div>
              {(canManage || task.createdById === me) && canEdit && !task.awaitingApproval && !task.parentId && task.assignee.id !== me ? (
                <select className="in" aria-label="Approver" value={task.approver?.id ?? ""} disabled={busy}
                  onChange={(e) => run(api("PUT", `/api/tasks/${id}/approver`, { approverId: e.target.value || null, expectedUpdatedAt: version }))}>
                  <option value="">None</option>
                  {workers.filter((w) => w.userId !== task.assignee.id).map((w) => <option key={w.userId} value={w.userId}>{w.name}</option>)}
                </select>
              ) : task.approver?.name ?? <span className="hint">None</span>}
            </div>
            <span className="lbl">Due date</span>
            <div>
              {canEdit && !holding ? (
                <span className="pills">
                  <input className="in" type="date" aria-label="Due date" style={{ width: "auto" }} defaultValue={task.dueDate ?? ""} key={task.updatedAt}
                    onChange={(e) => save({ dueDate: e.target.value || null })} />
                  {task.dueDate && <button className="link" onClick={() => save({ dueDate: null })}>Clear</button>}
                </span>
              ) : dueLabel(task.dueDate)}
            </div>
            {!task.parentId && (
              <>
                <span className="lbl">Section</span>
                <div>
                  {canEdit ? (
                    <select className="in" aria-label="Section" value={task.section.id} disabled={busy} onChange={(e) => move(e.target.value)}>
                      {project?.sections.map((s) => <option key={s.id} value={s.id}>{s.name}{s.isDone ? " (done)" : ""}</option>)}
                    </select>
                  ) : task.section.name}
                </div>
              </>
            )}
            <span className="lbl">Priority</span>
            <div>
              {canEdit && !holding ? (
                <select className="in" aria-label="Priority" style={{ width: "auto" }} value={task.priority} disabled={busy} onChange={(e) => save({ priority: e.target.value })}>
                  {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              ) : PRIORITY[task.priority]}
            </div>
            <span className="lbl">Blocked</span>
            <div>
              {canEdit && !holding ? (
                <label className="pills"><input type="checkbox" checked={task.blocked} disabled={busy} onChange={(e) => save({ blocked: e.target.checked, ...(e.target.checked ? {} : { blockedReason: null }) })} /> This task is blocked</label>
              ) : task.blocked ? "Yes" : "No"}
              {task.blocked && ((canEdit && !holding) || task.blockedReason) && (
                <textarea className="in blocked-reason" rows={1} readOnly={!canEdit || holding} aria-label="Why is it blocked?"
                  placeholder={canEdit && !holding ? "Why is it blocked?" : undefined} defaultValue={task.blockedReason ?? ""} key={task.updatedAt}
                  ref={(el) => { if (el && el.dataset.fitted !== "1") { fitBlockedReason(el); el.dataset.fitted = "1"; } }}
                  onInput={(e) => fitBlockedReason(e.currentTarget)}
                  onBlur={(e) => { if (!canEdit || holding) return; if ((e.target.value || null) !== (task.blockedReason ?? null)) save({ blockedReason: e.target.value || null }); }} />
              )}
            </div>
          </div>
          <div className="field">
            <label htmlFor="desc">Description</label>
            <textarea id="desc" className="in" readOnly={!canEdit || holding} defaultValue={task.description ?? ""} key={task.updatedAt} placeholder={canEdit ? "Add details" : "No description"}
              onBlur={(e) => { if ((e.target.value.trim() || null) !== (task.description ?? null)) save({ description: e.target.value.trim() || null }); }} />
          </div>
          {!task.parentId && (
            <div className="field">
              <span className="lbl">Subtasks {task.subtaskList.length > 0 && `(${task.subtaskList.filter((s) => s.completedAt).length} of ${task.subtaskList.length})`}</span>
              {task.subtaskList.map((s) => (
                <label className="sub-item" key={s.id}>
                  <input type="checkbox" aria-label={`Mark "${s.title}" ${s.completedAt ? "not done" : "done"}`} checked={!!s.completedAt} disabled={!canEdit || busy || (!s.canClose && !s.completedAt)}
                    onChange={() => run(api("POST", `/api/tasks/${s.id}/${s.completedAt ? "reopen" : "complete"}`, s.completedAt ? {} : { expectedUpdatedAt: s.updatedAt }))} />
                  <span style={s.completedAt ? { textDecoration: "line-through", color: "var(--muted)" } : undefined}>{s.title}</span>
                </label>
              ))}
              {canEdit && (
                <form className="addrow" onSubmit={async (e) => { e.preventDefault(); const v = newSub.trim(); if (!v) return; await run(api("POST", `/api/projects/${task.projectId}/tasks`, { title: v, parentId: id }), () => setNewSub("")); }}>
                  <input className="in" aria-label="New subtask" placeholder="Add a subtask" value={newSub} onChange={(e) => setNewSub(e.target.value)} />
                  <button className="btn ghost" disabled={busy || !newSub.trim()}>Add</button>
                </form>
              )}
            </div>
          )}
          {meCtx.crm && canEdit && !task.parentId && project?.type !== "DEAL" && !holding && (
            <div className="box" style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
                <input type="checkbox" checked={!!task.isIdea} disabled={busy} onChange={(e) => run(api("POST", `/api/tasks/${id}/idea`, { isIdea: e.target.checked }))} /> Idea
              </label>
              {!done && !task.awaitingApproval && <button className="btn ghost sm" disabled={busy} onClick={() => setConvert(true)}>Convert to deal</button>}
            </div>
          )}
          {meCtx.crm && !task.parentId && <TaskLinks taskId={id} links={task.links ?? []} canEdit={canEdit && !holding} onChanged={() => { t.reload(); onChanged?.(); }} />}
          <div className="actions" style={{ justifyContent: "flex-start" }}>
            {canEdit && !done && task.approver && !task.awaitingApproval && !task.parentId && task.assignee.id === me && (
              <button className="btn" disabled={busy} onClick={() => run(api("POST", `/api/tasks/${id}/send-for-approval`, {}))}>Send for approval</button>
            )}
            {canEdit && task.awaitingApproval && (task.approver?.id === me || canManage) && (
              <button className="btn ghost" disabled={busy} onClick={() => run(api("POST", `/api/tasks/${id}/send-back`, {}))}>Send back</button>
            )}
            {canEdit && !done && task.canClose && (
              <button className="btn" disabled={busy} onClick={() => complete()}>{task.approver ? "Close task" : "Mark complete"}</button>
            )}
            {canEdit && done && <button className="btn ghost" disabled={busy} onClick={() => run(api("POST", `/api/tasks/${id}/reopen`, {}))}>Reopen</button>}
          </div>
          {task.approver && !task.awaitingApproval && !done && task.assignee.id === me && (
            <p className="hint">Only {task.approver.name} or the project Leader can close this task. Send it for approval when it is ready.</p>
          )}
          {canEdit && !holding && (
            <div className="box dng" style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
              <span className="hint" style={{ color: "var(--danger)" }}>Kept 30 days. Everyone on the task is told. ({ROLE[role]})</span>
              <button className="btn ghost sm" style={{ color: "var(--danger)", borderColor: "var(--danger-line)" }} onClick={() => setTrash(true)}>Move to Trash</button>
            </div>
          )}
          {task.commentsEnabled && <Comments taskId={id} />}
        </>,
      )}
      {convert && <ConvertDialog task={task} meId={me} onClose={() => setConvert(false)} />}
      {confirm && (
        <Confirm title="Open subtasks" yes="Complete them all" busy={busy} onNo={() => setConfirm(null)}
          body={`This task has ${confirm.n} open subtask${confirm.n === 1 ? "" : "s"}. Complete them too?`}
          onYes={() => (confirm.kind === "complete" ? complete(true) : move(confirm.sectionId!, true))} />
      )}
      {trash && (
        <Confirm title="Move to Trash?" yes="Move to Trash" danger busy={busy} error={err} onNo={() => setTrash(false)}
          body="The task and its subtasks are kept for 30 days and can be restored from the project's Trash. Everyone on the task is told."
          onYes={async () => { const r = await api("DELETE", `/api/tasks/${id}`); if (r.ok) { onChanged?.(); onClose(); } else setErr(r.error ?? "Could not move it."); }} />
      )}
    </>
  );
}
