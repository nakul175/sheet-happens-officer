"use client";
import { finePointer } from "@/components/client";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { PRIORITY, ROLE, api, dueLabel, dueState, rowKeys, initials, isNetworkFailure, isOverdue, useGet } from "@/components/api";
import { TaskModal } from "@/components/TaskModal";
import { Tick } from "@/components/TaskParts";
import { Confirm, Field, LoadFailed, Menu, Modal } from "@/components/ui";
import { DealPanel, type DealBlock } from "@/components/DealPanel";
import { Page, useMe } from "../../Shell";

type T = {
  id: string; title: string; sectionId: string; priority: string; dueDate: string | null; blocked: boolean; completedAt: string | null; isIdea?: boolean;
  assignee: { id: string; name: string }; collaborators: { id: string; name: string }[]; awaitingApproval: boolean; canClose: boolean; subtasks: { total: number; open: number };
};
type S = { id: string; name: string; isDone: boolean; total: number; tasks: T[]; nextCursor: string | null };
type Proj = {
  id: string; name: string; archived: boolean; role: string; type?: "PROJECT" | "DEAL"; deal?: DealBlock | null;
  sections: { id: string; name: string; isDone: boolean }[];
  members: { userId: string; name: string; role: string; active: boolean }[];
};
const MAX_SECTIONS = 8;
/** SHO-US-14.17 AC3: the "Add people" banner stays dismissed on this device (a per-person convenience, so browser storage is enough). */
function nudgeSeen(projectId: string, set?: boolean) {
  const k = `sho.addpeople.${projectId}`;
  try { if (set) localStorage.setItem(k, "1"); return localStorage.getItem(k) === "1"; } catch { return false; }
}

function Inner({ id }: { id: string }) {
  const me = useMe();
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const view = sp.get("view") === "board" ? "board" : "list";
  const open = sp.get("task");
  const pr = useGet<{ project: Proj }>(`/api/projects/${id}`);
  const tk = useGet<{ sections: S[] }>(`/api/projects/${id}/tasks`);
  const [extra, setExtra] = useState<Record<string, T[]>>({}); // pages beyond the first, by section
  const [adding, setAdding] = useState(sp.get("new") === "1"); // SHO-US-14.17: a new project asks for its first task
  const [nudgeOff, setNudgeOff] = useState(false);
  const [dialog, setDialog] = useState<null | { kind: "rename" | "delete" | "addSection"; s?: S }>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [ask, setAsk] = useState<null | { taskId: string; sectionId: string; n: number }>(null);

  const refresh = useCallback(() => { pr.reload(); tk.reload(); setExtra({}); }, [pr, tk]);
  useEffect(() => { if (sp.get("new") === "1") window.history.replaceState(null, "", window.location.pathname); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { window.addEventListener("sho:task-added", refresh); return () => window.removeEventListener("sho:task-added", refresh); }, [refresh]); // SHO-US-14.5

  if (!pr.data && isNetworkFailure(pr.status)) {
    return <Page title="Project"><LoadFailed onRetry={refresh} /></Page>;
  }
  if (pr.status === 404 || (pr.error && !pr.data)) {
    return <Page title="This project isn't available"><div className="card empty">It may not exist, or you are not a member.<br /><Link href="/projects">Back to Projects</Link></div></Page>;
  }
  const p = pr.data?.project;
  const secs = tk.data?.sections;
  const canWrite = !!p && p.role !== "VIEWER" && !p.archived;
  const manage = !!p && p.role === "LEADER" && !p.archived;
  const setView = (v: string) => router.push(`${path}${v === "board" ? "?view=board" : ""}`, { scroll: false });
  const openTask = (tid: string) => router.push(`${path}?${view === "board" ? "view=board&" : ""}task=${tid}`, { scroll: false });
  const closeTask = () => router.push(`${path}${view === "board" ? "?view=board" : ""}`, { scroll: false });

  async function loadMore(s: S, all: boolean) {
    const cursorList = extra[s.id] ?? [];
    const cursor = all ? undefined : `${s.tasks.length + cursorList.length}`;
    void cursor;
    if (all) {
      const r = await api<{ sections: S[] }>("GET", `/api/projects/${id}/tasks?sectionId=${s.id}&all=true&limit=100`);
      if (r.ok) { setExtra((m) => ({ ...m, [s.id]: r.data.sections[0].tasks.slice(s.tasks.length) })); }
      return;
    }
    const next = s.nextCursor && !cursorList.length ? s.nextCursor : Buffer_next(s.tasks.length + cursorList.length);
    const r = await api<{ sections: S[] }>("GET", `/api/projects/${id}/tasks?sectionId=${s.id}&cursor=${next}`);
    if (r.ok) setExtra((m) => ({ ...m, [s.id]: [...cursorList, ...r.data.sections[0].tasks] }));
  }

  const showFewer = (sectionId: string) => setExtra((m) => { const n = { ...m }; delete n[sectionId]; return n; });

  async function moveTo(taskId: string, sectionId: string, all = false) {
    const r = await api("POST", `/api/tasks/${taskId}/move`, { sectionId, completeAll: all });
    if (r.ok) { setAsk(null); setErr(null); refresh(); }
    else if (r.status === 409 && r.data.needsConfirm === "open_subtasks") setAsk({ taskId, sectionId, n: r.data.openSubtasks });
    else setErr(r.error ?? "Could not move the task.");
  }

  const tasksOf = (s: S) => [...s.tasks, ...(extra[s.id] ?? [])];
  // SHO-US-5.3 AC6: a task may only be dropped into Done by someone who may close it.
  const canDrop = (taskId: string, to: S) => {
    if (!to.isDone) return true;
    const t = secs?.flatMap((x) => tasksOf(x)).find((x) => x.id === taskId);
    return !!t && (t.canClose || !!t.completedAt);
  };
  const archivedBanner = p?.archived && <div className="box warn" style={{ marginBottom: 12 }}>This project is archived and read-only.</div>;

  return (
    <Page dock={view === "list"} bar={view === "board"} docTitle={p?.name}
      title={<span className="crumb"><Link href={p?.type === "DEAL" ? "/deals" : "/projects"}>{p?.type === "DEAL" ? "Deals" : "Projects"}</Link> / <span style={{ color: "var(--ink)" }}>{p?.name ?? "…"}</span></span>}
      sub={p && <span className="chip">You: {ROLE[p.role]}</span>}
      actions={canWrite && <button className="btn" onClick={() => setAdding(true)}>+ Add task</button>}>
      {archivedBanner}
      {manage && p && p.members.filter((m) => m.active).length === 1 && !nudgeOff && !nudgeSeen(p.id) && (
        <div className="nudge" role="region" aria-label="Add people">
          <span className="grow"><b>Only you are in this project.</b> Add the people who will work on it.</span>
          <Link className="btn sm" href={`/projects/${id}/members`}>Add people</Link>
          <button className="btn ghost sm" onClick={() => { nudgeSeen(p.id, true); setNudgeOff(true); }}>Dismiss</button>
        </div>
      )}
      {p?.deal && <DealPanel projectId={id} deal={p.deal} canWrite={canWrite} onChange={refresh} />}
      <div className="tabs">
        <div className="seg" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === "list"} aria-current={view === "list"} onClick={() => setView("list")}>List</button>
          <button role="tab" aria-selected={view === "board"} aria-current={view === "board"} onClick={() => setView("board")}>Board</button>
        </div>
        <span className="sp" />
        <Link href={`/projects/${id}/members`}>Members</Link>
        <Link href={`/projects/${id}/trash`}>Trash</Link>
        {p && (p.role === "LEADER") && <Link href={`/projects/${id}/activity`}>Activity</Link>}
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      {(pr.loading || tk.loading) && <div className="skel">Loading…</div>}

      {secs && view === "list" && secs.map((s) => {
        const list = tasksOf(s);
        const more = s.isDone ? s.total > list.length : !!s.nextCursor && list.length < s.total;
        return (
          <section key={s.id} aria-label={s.name}>
            <div className="grp" style={{ display: "flex", alignItems: "center" }}>
              <span>{s.name} · {s.total}{s.isDone && " (done)"}</span>
              {manage && <SectionMenu s={s} secs={secs} projectId={id} onDialog={(kind) => setDialog({ kind, s })} onDone={refresh} onErr={setErr} />}
            </div>
            <div className="list">
              {list.map((t) => (
                <div key={t.id} className="item click" {...rowKeys(() => openTask(t.id))}>
                  <Tick id={t.id} title={t.title} done={!!t.completedAt} allowed={canWrite && (t.canClose || !!t.completedAt)} onDone={refresh} />
                  <div className="t"><b>{t.title}</b>{t.subtasks.total > 0 && <small>{t.subtasks.total - t.subtasks.open} of {t.subtasks.total} subtasks</small>}</div>
                  <div className="meta">
                    {t.awaitingApproval && <span className="chip gold">Awaiting approval</span>}
                    {t.isIdea && <span className="chip gold">Idea</span>}{t.blocked && <span className="chip red">Blocked</span>}
                    <span>{t.assignee.name}</span>
                    <span className={`pri-${t.priority}`}>{PRIORITY[t.priority]}</span>
                    <span className={!t.completedAt && isOverdue(t.dueDate) ? "over" : undefined}>{dueState(t.dueDate, !!t.completedAt)}</span>
                  </div>
                </div>
              ))}
              {!list.length && <div className="item"><span className="hint">No tasks here.</span></div>}
              {canWrite && !s.isDone && <QuickAdd projectId={id} sectionId={s.id} onAdded={refresh} />}
            </div>
            {s.isDone && s.total > 10 && (
              <p className="hint">
                {list.length < s.total
                  ? <>Done is collapsed: the {list.length} most recent · <button className="link" onClick={() => loadMore(s, true)}>Show all {s.total}</button></>
                  : <>Showing all {s.total} · <button className="link" onClick={() => showFewer(s.id)}>Collapse to the 10 most recent</button></>}
              </p>
            )}
            {!s.isDone && more && <p><button className="link" onClick={() => loadMore(s, false)}>Load more</button></p>}
          </section>
        );
      })}

      {secs && view === "board" && (
        <div className="board">
          {secs.map((s) => (
            <div key={s.id} className={`col${overCol === s.id ? " over" : ""}`} aria-label={s.name}
              onDragOver={(e) => { if (dragId && canWrite && canDrop(dragId, s)) { e.preventDefault(); setOverCol(s.id); } }}
              onDragLeave={() => setOverCol((c) => (c === s.id ? null : c))}
              onDrop={(e) => { e.preventDefault(); setOverCol(null); const tid = dragId; setDragId(null); if (tid && canWrite && canDrop(tid, s)) { const from = secs.flatMap((x) => tasksOf(x)).find((x) => x.id === tid); if (from && from.sectionId !== s.id) moveTo(tid, s.id); } }}>
              <h4>{s.name} <span className="n">{s.total}</span>
                {manage && <SectionMenu s={s} secs={secs} projectId={id} onDialog={(kind) => setDialog({ kind, s })} onDone={refresh} onErr={setErr} />}
              </h4>
              {tasksOf(s).map((t) => (
                <div key={t.id} className="bcard" draggable={canWrite} onDragStart={() => setDragId(t.id)} onDragEnd={() => { setDragId(null); setOverCol(null); }}
                  onClick={() => openTask(t.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") openTask(t.id); }}>
                  <div>{t.title}</div>
                  <div className="row2">
                    <span className={!t.completedAt && isOverdue(t.dueDate) ? "over" : undefined} style={isOverdue(t.dueDate) && !t.completedAt ? { color: "var(--danger)" } : undefined}>{dueState(t.dueDate, !!t.completedAt)}</span>
                    <span className={`pri-${t.priority}`}>{PRIORITY[t.priority]}</span>
                    {t.subtasks.total > 0 && <span>{t.subtasks.total - t.subtasks.open} of {t.subtasks.total}</span>}
                    {t.isIdea && <span className="chip gold">Idea</span>}{t.blocked && <span className="chip red">Blocked</span>}
                    {t.awaitingApproval && <span className="chip gold">Awaiting</span>}
                    <span className="avs" style={{ marginLeft: "auto" }} aria-label={`Assignee ${t.assignee.name}${t.collaborators.length ? `; collaborators ${t.collaborators.map((c) => c.name).join(", ")}` : ""}`}>
                      <span className="av sm" title={`Assignee: ${t.assignee.name}`}>{initials(t.assignee.name)}</span>
                      {t.collaborators.slice(0, 3).map((c) => <span key={c.id} className="av sm collab" title={`Collaborator: ${c.name}`}>{initials(c.name)}</span>)}
                      {t.collaborators.length > 3 && <span className="av sm collab" title={t.collaborators.slice(3).map((c) => c.name).join(", ")}>+{t.collaborators.length - 3}</span>}
                    </span>
                  </div>
                  {canWrite && (
                    <select className="in" aria-label={`Move "${t.title}" to`} style={{ marginTop: 8, padding: "3px 6px", fontSize: 12 }} value={s.id}
                      onClick={(e) => e.stopPropagation()} onChange={(e) => moveTo(t.id, e.target.value)}>
                      {secs.filter((x) => !x.isDone || t.canClose || x.id === s.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  )}
                </div>
              ))}
              {s.isDone && s.total > 10 && (
                tasksOf(s).length < s.total
                  ? <p className="hint" style={{ margin: 4 }}>Collapsed: {tasksOf(s).length} most recent · <button className="link" onClick={() => loadMore(s, true)}>Show all {s.total}</button></p>
                  : <p className="hint" style={{ margin: 4 }}>Showing all {s.total} · <button className="link" onClick={() => showFewer(s.id)}>Collapse</button></p>
              )}
              {canWrite && !s.isDone && <QuickAdd compact projectId={id} sectionId={s.id} onAdded={refresh} />}
            </div>
          ))}
        </div>
      )}
      {secs && manage && (
        <div style={{ marginTop: 16 }}>
          <button className="btn ghost" disabled={secs.length >= MAX_SECTIONS} onClick={() => setDialog({ kind: "addSection" })}>+ Add section</button>
          {secs.length >= MAX_SECTIONS && <span className="hint"> A project can have up to {MAX_SECTIONS} sections.</span>}
        </div>
      )}
      {secs && p && p.role !== "LEADER" && <p className="hint" style={{ marginTop: 16 }}>Only the Leader and Admins can change sections.</p>}

      {open && <TaskModal id={open} me={me.id} onClose={closeTask} onChanged={refresh} />}
      {adding && p && <NewTask p={p} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); refresh(); }} />}
      {dialog?.kind === "addSection" && <SectionName title="Add section" yes="Add section" onClose={() => setDialog(null)} onSave={(name) => api("POST", `/api/projects/${id}/sections`, { name })} onDone={() => { setDialog(null); refresh(); }} />}
      {dialog?.kind === "rename" && dialog.s && <SectionName title="Rename section" yes="Save" initial={dialog.s.name} onClose={() => setDialog(null)} onSave={(name) => api("PATCH", `/api/projects/${id}/sections/${dialog.s!.id}`, { name })} onDone={() => { setDialog(null); refresh(); }} />}
      {dialog?.kind === "delete" && dialog.s && secs && <DeleteSection s={dialog.s} secs={secs} projectId={id} onClose={() => setDialog(null)} onDone={() => { setDialog(null); refresh(); }} />}
      {ask && (
        <Confirm title="Open subtasks" yes="Complete them all" onNo={() => setAsk(null)} body={`This task has ${ask.n} open subtask${ask.n === 1 ? "" : "s"}. Complete them too?`} onYes={() => moveTo(ask.taskId, ask.sectionId, true)} />
      )}
    </Page>
  );
}

function Buffer_next(n: number) { return btoa(String(n)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

function SectionMenu({ s, secs, projectId, onDialog, onDone, onErr }: { s: S; secs: S[]; projectId: string; onDialog: (k: "rename" | "delete") => void; onDone: () => void; onErr: (m: string | null) => void }) {
  const i = secs.findIndex((x) => x.id === s.id);
  async function patch(body: object) {
    const r = await api("PATCH", `/api/projects/${projectId}/sections/${s.id}`, body);
    if (r.ok) { onErr(null); onDone(); } else onErr(r.error ?? "Could not change the section.");
  }
  return (
    <Menu label={`Section menu for ${s.name}`}>
      {(close) => (
        <>
          <button role="menuitem" onClick={() => { close(); onDialog("rename"); }}>Rename</button>
          <button role="menuitem" disabled={i === 0} onClick={() => { close(); patch({ move: "left" }); }}>Move left</button>
          <button role="menuitem" disabled={i === secs.length - 1} onClick={() => { close(); patch({ move: "right" }); }}>Move right</button>
          <button role="menuitem" disabled={s.isDone} onClick={() => { close(); patch({ isDone: true }); }}>{s.isDone ? "This is the done section" : "Treat as done"}</button>
          <button role="menuitem" disabled={s.isDone || secs.length <= 1} onClick={() => { close(); onDialog("delete"); }}>Delete…</button>
        </>
      )}
    </Menu>
  );
}

function QuickAdd({ projectId, sectionId, onAdded, compact }: { projectId: string; sectionId: string; onAdded: () => void; compact?: boolean }) {
  const [v, setV] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form className={compact ? undefined : "item"} style={compact ? { marginTop: 4 } : undefined} onSubmit={async (e) => {
      e.preventDefault();
      if (!v.trim()) return;
      setBusy(true);
      const r = await api("POST", `/api/projects/${projectId}/tasks`, { title: v.trim(), sectionId });
      setBusy(false);
      if (r.ok) { setV(""); setErr(null); onAdded(); } else setErr(r.error ?? "Could not add the task.");
    }}>
      <input className="in" aria-label="Add a task" placeholder="+ Add a task" value={v} disabled={busy} onChange={(e) => setV(e.target.value)} style={compact ? { background: "transparent" } : { border: 0, padding: 0 }} />
      {err && <span className="err" role="alert">{err}</span>}
    </form>
  );
}

function NewTask({ p, onClose, onAdded }: { p: Proj; onClose: () => void; onAdded: () => void }) {
  const me = useMe();
  const workers = p.members.filter((m) => m.active && (m.role === "LEADER" || m.role === "EDITOR"));
  const [title, setTitle] = useState("");
  const [section, setSection] = useState(p.sections.find((s) => !s.isDone)?.id ?? p.sections[0].id);
  const [assignee, setAssignee] = useState(workers.some((w) => w.userId === me.id) ? me.id : workers[0]?.userId ?? "");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal label="Add task" onClose={onClose}>
      <h2>Add task</h2>
      <form onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const r = await api("POST", `/api/projects/${p.id}/tasks`, { title, sectionId: section, assigneeId: assignee || undefined, dueDate: due || null, priority });
        setBusy(false);
        if (r.ok) onAdded(); else setErr(r.error ?? "Could not add the task.");
      }}>
        <Field label="Title">{(id) => <input id={id} className="in" value={title} required maxLength={500} autoFocus={finePointer()} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label="Section">{(id) => <select id={id} className="in" value={section} onChange={(e) => setSection(e.target.value)}>{p.sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</Field>
        <Field label="Assignee">{(id) => <select id={id} className="in" value={assignee} onChange={(e) => setAssignee(e.target.value)}>{workers.map((w) => <option key={w.userId} value={w.userId}>{w.name}</option>)}</select>}</Field>
        <Field label="Due date (optional)">{(id) => <input id={id} className="in" type="date" value={due} onChange={(e) => setDue(e.target.value)} />}</Field>
        <Field label="Priority">{(id) => <select id={id} className="in" value={priority} onChange={(e) => setPriority(e.target.value)}>{Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
        {err && <div className="err" role="alert">{err}</div>}
        <div className="actions"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !title.trim()}>Add task</button></div>
      </form>
    </Modal>
  );
}

function SectionName({ title, yes, initial = "", onSave, onClose, onDone }: { title: string; yes: string; initial?: string; onSave: (n: string) => Promise<{ ok: boolean; error?: string }>; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal small label={title} onClose={onClose}>
      <h2>{title}</h2>
      <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); const r = await onSave(v.trim()); setBusy(false); if (r.ok) onDone(); else setErr(r.error ?? "Could not save."); }}>
        <Field label="Section name">{(id) => <input id={id} className="in" value={v} maxLength={60} autoFocus={finePointer()} onChange={(e) => setV(e.target.value)} />}</Field>
        {err && <div className="err" role="alert">{err}</div>}
        <div className="actions"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !v.trim()}>{yes}</button></div>
      </form>
    </Modal>
  );
}

function DeleteSection({ s, secs, projectId, onClose, onDone }: { s: S; secs: S[]; projectId: string; onClose: () => void; onDone: () => void }) {
  const others = secs.filter((x) => x.id !== s.id);
  const [dest, setDest] = useState(others.find((x) => !x.isDone)?.id ?? others[0]?.id ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Confirm title={`Delete "${s.name}"?`} yes="Delete section" danger busy={busy} error={err} onNo={onClose}
      body={s.total ? `This section has ${s.total} task${s.total === 1 ? "" : "s"}. Choose where they go.` : "This section is empty."}
      onYes={async () => { setBusy(true); const r = await api("DELETE", `/api/projects/${projectId}/sections/${s.id}?moveTo=${dest}`); setBusy(false); if (r.ok) onDone(); else setErr(r.error ?? "Could not delete."); }}>
      <Field label="Move its tasks to">{(id) => <select id={id} className="in" value={dest} onChange={(e) => setDest(e.target.value)}>{others.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}</Field>
    </Confirm>
  );
}

export default function ProjectView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Suspense><Inner id={id} /></Suspense>;
}
