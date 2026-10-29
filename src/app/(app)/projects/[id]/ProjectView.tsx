"use client";
import { personText } from "@/components/PeopleSelect";
import { finePointer } from "@/components/client";
import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { PRIORITY, ROLE, api, dueLabel, dueState, rowKeys, isOverdue, todayIST, useGet } from "@/components/api";
import { errorMessage, isVersionConflict } from "@/lib/version-error";
import { HolySheetDocuments } from "@/components/HolySheetDocuments";
import { WorkspaceTaskPerson, type WorkspaceTaskCandidate } from "@/components/WorkspaceTaskPerson";
import { TaskModal } from "@/components/TaskModal";
import { openTaskSheet } from "@/lib/task-sheet-history";
import { AvatarGroup, Pri, SectionSelection, Tick } from "@/components/TaskParts";
import { Confirm, Field, LoadFailed, Menu, Modal, Skeleton } from "@/components/ui";
import { MoveSheet } from "@/components/MoveSheet";
import "@/components/board.css";
import { DealPanel, openTaskFeed, type DealBlock, type OpenTaskFeed } from "@/components/DealPanel";
import { Page, useMe } from "../../Shell";
import "../projects.css";
import "./approved-list.css";
import "../../accounts/forms-approved.css";
import "./add-task-approved.css";
import "./approved-board.css";
import { InlineCells, inlineEditable, useInlineEdit } from "@/components/inline";
import { ListControls } from "./ListControls";
import { apiQuery, groupTasks, isFiltered, readState, sameState, type ListState } from "./listview";
import { SaveViewDialog, type SavedView } from "./SavedViews";
import { BulkBar, type BulkResult } from "./BulkBar";
import { canDropOnSection, completeTickAllowed, moveMenuSections } from "@/lib/approver-ui";

type T = {
  id: string; title: string; updatedAt: string; sectionId: string; priority: string; dueDate: string | null; blocked: boolean; completedAt: string | null; isIdea?: boolean;
  assignee: { id: string; name: string }; collaborators: { id: string; name: string }[]; awaitingApproval: boolean; canClose: boolean; subtasks: { total: number; open: number };
  commentCount?: number;
};
type S = { id: string; name: string; isDone: boolean; total: number; tasks: T[]; nextCursor: string | null };
type Summary = { open: number; overdue: number; blocked: number; awaiting: number; openTasks?: number };
type Proj = {
  id: string; name: string; archived: boolean; role: string; isVertical?: boolean; type?: "PROJECT" | "DEAL"; deal?: DealBlock | null;
  sections: { id: string; name: string; isDone: boolean }[];
  members: { userId: string; name: string; email?: string; role: string; active: boolean }[];
};
const MAX_SECTIONS = 8;
// SHO-US-22.6 AC6: dragging is for devices with a mouse. On a touch screen it would fight scrolling, so Move to… is used.
const MOUSE = "(hover: hover) and (pointer: fine)";
const useMouse = () => useSyncExternalStore(
  (cb) => { const m = window.matchMedia(MOUSE); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
  () => window.matchMedia(MOUSE).matches,
  () => false,
);
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
  const ls = readState(sp);
  const filtered = isFiltered(ls);
  const wide = filtered || ls.sort !== "date" || ls.group !== "section"; // the server sent every matching task, not one page per section
  const tk = useGet<{ sections: S[]; summary?: Summary }>(`/api/projects/${id}/tasks${apiQuery(ls)}`);
  const [extra, setExtra] = useState<Record<string, T[]>>({}); // pages beyond the first, by section
  const [adding, setAdding] = useState(sp.get("new") === "1"); // SHO-US-14.17: a new project asks for its first task
  const [nudgeOff, setNudgeOff] = useState(false);
  const [dialog, setDialog] = useState<null | { kind: "rename" | "delete" | "addSection"; s?: S }>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [ask, setAsk] = useState<null | { taskId: string; sectionId: string; n: number }>(null);
  const [moving, setMoving] = useState<T | null>(null); // task whose Move to… sheet is open
  const [cur, setCur] = useState(0); // column in view on a phone
  const mouse = useMouse();
  const boardEl = useRef<HTMLDivElement>(null);
  const raf = useRef(0);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  const onBoardScroll = () => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const b = boardEl.current; if (!b) return;
      const cols = Array.from(b.querySelectorAll<HTMLElement>(":scope > .col"));
      const x = b.scrollLeft + 1; let at = 0;
      cols.forEach((c, i) => { if (c.offsetLeft - b.offsetLeft <= x + 40) at = i; });
      if (b.scrollLeft + b.clientWidth >= b.scrollWidth - 2) at = cols.length - 1;
      setCur(at);
    });
  };
  const jump = (i: number) => {
    const b = boardEl.current; const c = b?.querySelectorAll<HTMLElement>(":scope > .col")[i];
    if (!b || !c) return;
    setCur(i);
    b.scrollTo({ left: c.offsetLeft - b.offsetLeft, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  const refresh = useCallback(() => { pr.reload(); tk.reload(); setExtra({}); }, [pr, tk]);
  const inline = useInlineEdit(refresh);
  const vw = useGet<{ views: SavedView[]; max: number }>(`/api/projects/${id}/views`);
  const [sel, setSel] = useState<Set<string>>(new Set()); // ticked tasks (SHO-US-14.11)
  const [bulk, setBulk] = useState<BulkResult | null>(null);
  const [viewDialog, setViewDialog] = useState<null | "save" | "rename" | "delete">(null);
  useEffect(() => { if (sp.get("new") === "1") window.history.replaceState(null, "", window.location.pathname); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { window.addEventListener("sho:task-added", refresh); return () => window.removeEventListener("sho:task-added", refresh); }, [refresh]); // SHO-US-14.5

  if (!pr.data && pr.failed) {
    return <Page title="Project"><LoadFailed onRetry={refresh} /></Page>;
  }
  if (pr.status === 404 || (pr.error && !pr.data)) {
    return <Page title="This project isn't available"><div className="card empty">It may not exist, or you are not a member.<br /><Link href="/projects">Back to Projects</Link></div></Page>;
  }
  const p = pr.data?.project;
  const secs = tk.data?.sections;
  // APL-2691: Won and Lost read this list. The count includes subtasks, the same set the move refuses.
  const openFeed: OpenTaskFeed = secs
    ? openTaskFeed(secs, tk.data?.summary?.open, filtered, tk.data?.summary?.openTasks)
    : { status: tk.failed || tk.error ? "error" : "loading", openCount: 0, tasks: [] };
  const canWrite = !!p && p.role !== "VIEWER" && !p.archived;
  const manage = !!p && p.role === "LEADER" && !p.archived;
  // The address keeps the view, the open task and the filter, sort and group choices.
  const urlWith = (over: Record<string, string | null>) => {
    const q = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(over)) { if (v) q.set(k, v); else q.delete(k); }
    const t = q.toString();
    return `${path}${t ? `?${t}` : ""}`;
  };
  const setView = (v: string) => router.push(urlWith({ view: v === "board" ? "board" : null, task: null }), { scroll: false });
  const openTask = (tid: string) => { const href = urlWith({ task: tid }); if (!openTaskSheet(href)) router.push(href, { scroll: false }); };
  const closeTask = () => router.replace(urlWith({ task: null }), { scroll: false });
  const views = vw.data?.views ?? [];
  const maxViews = vw.data?.max ?? 10;
  const activeView = view === "list" ? views.find((v) => sameState(v.state, ls)) : undefined;
  const openView = (v: SavedView) => router.push(urlWith({ view: null, task: null, assignee: v.state.assignee || null, f: v.state.flags.join(",") || null, priority: v.state.priority || null, sort: v.state.sort === "date" ? null : v.state.sort, group: v.state.group === "section" ? null : v.state.group }), { scroll: false });
  const setList = (patch: Partial<ListState>) => {
    const n = { ...ls, ...patch };
    router.replace(urlWith({ assignee: n.assignee || null, f: n.flags.join(",") || null, priority: n.priority || null, sort: n.sort === "date" ? null : n.sort, group: n.group === "section" ? null : n.group }), { scroll: false });
    setExtra({});
    setSel(new Set());
  };

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

  // APL-2668: a change is made on the version the page shows.
  const versionOf = (taskId: string) => secs?.flatMap((x) => tasksOf(x)).find((x) => x.id === taskId)?.updatedAt ?? "";
  async function moveTo(taskId: string, sectionId: string, all = false) {
    const r = await api("POST", `/api/tasks/${taskId}/move`, { sectionId, completeAll: all, expectedUpdatedAt: versionOf(taskId) });
    if (r.ok) { setAsk(null); setErr(null); refresh(); }
    else if (isVersionConflict(r.status, r.data)) { setAsk(null); setErr(errorMessage(r.error, "This task changed while you were editing it.")); refresh(); }
    else if (r.status === 409 && r.data.needsConfirm === "open_subtasks") setAsk({ taskId, sectionId, n: r.data.openSubtasks });
    else setErr(errorMessage(r.error, "Could not move the task."));
  }

  const tasksOf = (s: S) => [...s.tasks, ...(extra[s.id] ?? [])];
  // SHO-US-5.3 AC6 / APL-2660 AC4: a task may only be dropped into Done by someone who may close it.
  const canDrop = (taskId: string, to: S) => {
    const t = secs?.flatMap((x) => tasksOf(x)).find((x) => x.id === taskId);
    return canDropOnSection(t, to.isDone);
  };
  const pick = (ids: string[], on: boolean) => setSel((cur) => { const n = new Set(cur); for (const i of ids) { if (on) n.add(i); else n.delete(i); } return n; });
  const rowOf = (t: T) => (
    <div key={t.id} className={`item click${canWrite ? " sel-row" : ""}${sel.has(t.id) ? " picked" : ""}`} {...rowKeys(() => openTask(t.id))}>
      {canWrite && <label className="sel" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(t.id)} aria-label={`Select "${t.title}"`} onChange={(e) => pick([t.id], e.target.checked)} /></label>}
      <Tick id={t.id} title={t.title} done={!!t.completedAt} allowed={completeTickAllowed({ canWrite, canClose: t.canClose, completedAt: t.completedAt })} disabledReason={p?.archived ? "This project is archived and read-only." : p?.role === "VIEWER" ? "Viewers can read tasks but cannot change them." : undefined} version={t.updatedAt} onDone={refresh} onStale={refresh} />
      <div className="t"><b className="ttl">{t.title}</b>{t.subtasks.total > 0 && <small>{t.subtasks.total - t.subtasks.open} of {t.subtasks.total} subtasks</small>}{!!t.commentCount && <small>{t.commentCount} {t.commentCount === 1 ? "comment" : "comments"}</small>}</div>
      <div className="meta">
        {t.awaitingApproval && <span className="chip gold">Awaiting approval</span>}
        {t.isIdea && <span className="chip gold">Idea</span>}{t.blocked && <span className="chip red">Blocked</span>}
        <InlineCells t={t} people={p?.members ?? []} editable={canWrite && inlineEditable(p!.role, t, me.id)} onEdit={inline.run} />
      </div>
    </div>
  );
  const archivedBanner = p?.archived && <div className="box warn" style={{ marginBottom: 12 }}>This project is archived and read-only.</div>;

  return (
    <Page bar className={view === "list" ? "project-list-view" : "project-board-view"} docTitle={p?.name}
      beforeTitle={<nav className="project-breadcrumb" aria-label="Breadcrumb"><Link href={p?.type === "DEAL" ? "/deals" : "/projects"}>{p?.type === "DEAL" ? "Deals" : "Projects"}</Link> / {p?.name ?? "…"}</nav>}
      title={p?.name ?? "…"}
      sub={p && <>{p.isVertical && <span className="chip">Vertical task board</span>}<span className="chip">You: {ROLE[p.role]}</span>{tk.data?.summary && (
        <span className="lc-sum">
          {tk.data.summary.overdue > 0 && <span className="chip red">{tk.data.summary.overdue} overdue</span>}
          {tk.data.summary.blocked > 0 && <span className="chip red">{tk.data.summary.blocked} blocked</span>}
          {tk.data.summary.awaiting > 0 && <span className="chip gold">{tk.data.summary.awaiting} awaiting approval</span>}
        </span>
      )}</>}
      actions={<>
        {<div className="project-secondary-actions"><Link href={`/projects/${id}/members`}>Settings</Link>{p && p.role !== "VIEWER" && <Link href={`/projects/${id}/activity`}>Activity</Link>}<Link href={`/projects/${id}/trash`}>Trash</Link></div>}
        {canWrite && <button className="btn" onClick={() => setAdding(true)}>+ Add task</button>}
      </>}>
      {archivedBanner}
      {manage && p && p.members.filter((m) => m.active).length === 1 && !nudgeOff && !nudgeSeen(p.id) && (
        <div className="nudge" role="region" aria-label="Add people">
          <span className="grow"><b>Only you are in this project.</b> Add the people who will work on it.</span>
          <Link className="btn sm" href={`/projects/${id}/members`}>Add people</Link>
          <button className="btn ghost sm" onClick={() => { nudgeSeen(p.id, true); setNudgeOff(true); }}>Dismiss</button>
        </div>
      )}
      <HolySheetDocuments key={id} kind="projects" id={id} />
      {p?.deal && <DealPanel projectId={id} deal={p.deal} canWrite={canWrite} canManage={manage} onChange={refresh} feed={openFeed} />}
      <div className="tabs">
        <div className="seg" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === "list"} onClick={() => setView("list")}>List</button>
          <button role="tab" aria-selected={view === "board"} onClick={() => setView("board")}>Board</button>
        </div>
        {views.length > 0 && (
          <div className="vtabs" role="group" aria-label="Saved views">
            {views.map((v) => <button key={v.id} className="vtab" aria-pressed={activeView?.id === v.id} onClick={() => openView(v)}>{v.name}</button>)}
          </div>
        )}
        <span className="sp" />

      </div>
      {p && secs && (
        <ListControls state={ls} members={p.members} onChange={setList} showGroup={view === "list"}
          found={wide && filtered ? secs.reduce((n, x) => n + x.tasks.length, 0) : null}
          onSave={view === "list" && !activeView && (filtered || ls.sort !== "date" || ls.group !== "section") ? () => setViewDialog("save") : undefined}
          saveWhy={views.length >= maxViews ? `You have ${maxViews} saved views in this project, the most allowed. Delete one to save another.` : null}>
          {activeView && <>
            <button type="button" className="btn ghost" onClick={() => setViewDialog("rename")}>Rename view</button>
            <button type="button" className="btn ghost" onClick={() => setViewDialog("delete")}>Delete view</button>
          </>}
        </ListControls>
      )}
      {err && <div className="err" role="alert">{err}</div>}
      {inline.notice}
      {bulk && (
        <div className={bulk.skipped.length ? "box warn" : "ok"} role="status" style={{ marginBottom: 12 }}>
          <div className="bulk-msg"><span>{bulk.message}.</span><button className="link" onClick={() => setBulk(null)}>Dismiss</button></div>
          {bulk.skipped.length > 0 && <details><summary>Which tasks were skipped</summary><ul>{bulk.skipped.map((x) => <li key={x.id}>{x.title}: {x.reason}</li>)}</ul></details>}
        </div>
      )}
      {(pr.loading || tk.loading) && !secs && <Skeleton />}
      {secs && filtered && secs.every((x) => !x.tasks.length) && (
        <div className="card nomatch"><b>No tasks match</b><button className="btn ghost" onClick={() => setList({ assignee: "", flags: [], priority: "" })}>Clear filters</button></div>
      )}

      {secs && view === "list" && ls.group === "section" && secs.filter((s) => !filtered || s.tasks.length > 0).map((s) => {
        const list = tasksOf(s);
        const more = s.isDone ? s.total > list.length : !!s.nextCursor && list.length < s.total;
        return (
          <section className="project-task-section" key={s.id} aria-label={s.name}>
            <div className="grp" style={{ display: "flex", alignItems: "center" }}>
              {canWrite && list.length > 0 && <SectionSelection selected={list.filter(t => sel.has(t.id)).length} total={list.length} label={`Select all in ${s.name}`} onChange={checked => pick(list.map(t => t.id), checked)} />}
              <span>{s.name} · {s.total}{s.isDone && " (done)"}</span>
              {manage && <SectionMenu s={s} secs={secs} projectId={id} onDialog={(kind) => setDialog({ kind, s })} onDone={refresh} onErr={setErr} />}
            </div>
            <div className="list">
              {list.map(rowOf)}
              {!list.length && <div className="item"><span className="hint">No tasks here.</span></div>}
              {canWrite && !s.isDone && !wide && <QuickAdd projectId={id} sectionId={s.id} onAdded={refresh} />}
            </div>
            {s.isDone && s.total > 10 && !wide && (
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

      {secs && view === "list" && ls.group !== "section" && groupTasks(secs.flatMap((x) => x.tasks), ls.group, todayIST(), ls.sort).map((g) => (
        <section className="project-task-section" key={g.key} aria-label={g.name}>
          <div className="grp">
            {canWrite && <SectionSelection selected={g.tasks.filter(t => sel.has(t.id)).length} total={g.tasks.length} label={`Select all in ${g.name}`} onChange={checked => pick(g.tasks.map(t => t.id), checked)} />}
            <span>{g.name} · {g.tasks.length}</span>
          </div>
          <div className="list">{g.tasks.map(rowOf)}</div>
        </section>
      ))}

      {secs && view === "board" && (
        <>
        <div className="bswitch" role="tablist" aria-label="Board columns">
          {secs.map((s, i) => <button key={s.id} role="tab" aria-selected={cur === i} onClick={() => jump(i)}>{s.name}<b>{s.total}</b></button>)}
        </div>
        <div className="board" ref={boardEl} onScroll={onBoardScroll}>
          {secs.map((s) => (
            <div key={s.id} className={`col${overCol === s.id ? " over" : ""}`} aria-label={s.name}
              onDragOver={(e) => { if (dragId && canWrite && canDrop(dragId, s)) { e.preventDefault(); setOverCol(s.id); } }}
              onDragLeave={() => setOverCol((c) => (c === s.id ? null : c))}
              onDrop={(e) => { e.preventDefault(); setOverCol(null); const tid = dragId; setDragId(null); if (tid && canWrite && canDrop(tid, s)) { const from = secs.flatMap((x) => tasksOf(x)).find((x) => x.id === tid); if (from && from.sectionId !== s.id) moveTo(tid, s.id); } }}>
              <h2>{s.name} <span className="n">{s.total}</span>
                {manage && <SectionMenu s={s} secs={secs} projectId={id} onDialog={(kind) => setDialog({ kind, s })} onDone={refresh} onErr={setErr} />}
              </h2>
              {tasksOf(s).map((t) => (
                <div key={t.id} className="bcard" draggable={canWrite && mouse} onDragStart={() => setDragId(t.id)} onDragEnd={() => { setDragId(null); setOverCol(null); }}
                  onClick={() => openTask(t.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") openTask(t.id); }}>
                  <div className="board-task-title">{t.title}{t.completedAt && <span className="board-complete" aria-label="Completed"> ✓</span>}</div>
                  <div className="row2">
                    <span className={!t.completedAt && isOverdue(t.dueDate) ? "over" : undefined} style={isOverdue(t.dueDate) && !t.completedAt ? { color: "var(--danger)" } : undefined}>{dueState(t.dueDate, !!t.completedAt)}</span>
                    <Pri p={t.priority} />
                    {t.subtasks.total > 0 && <span>{t.subtasks.total - t.subtasks.open} of {t.subtasks.total}</span>}
                    {!!t.commentCount && <span>{t.commentCount} {t.commentCount === 1 ? "comment" : "comments"}</span>}
                    {t.isIdea && <span className="chip gold">Idea</span>}{t.blocked && <span className="chip red">Blocked</span>}
                    {t.awaitingApproval && <span className="chip gold">Awaiting</span>}
                    <AvatarGroup assignee={t.assignee} collaborators={t.collaborators} />
                  </div>
                  {canWrite && (
                    <button className="btn ghost sm bmove" aria-label={`Move to… "${t.title}"`} aria-haspopup="dialog"
                      onClick={(e) => { e.stopPropagation(); setMoving(t); }}>Move to…</button>
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
        </>
      )}
      {moving && secs && (
        <MoveSheet title={`Move to… ${moving.title.length > 60 ? moving.title.slice(0, 57) + "…" : moving.title}`}
          options={moveMenuSections(secs, moving).map((x) => ({ id: x.id, name: x.name, current: x.id === moving.sectionId }))}
          onClose={() => setMoving(null)}
          onPick={(sid) => { const t = moving; setMoving(null); void moveTo(t.id, sid); }} />
      )}
      {secs && manage && (
        <div style={{ marginTop: 16 }}>
          <button className="btn ghost" disabled={secs.length >= MAX_SECTIONS} onClick={() => setDialog({ kind: "addSection" })}>+ Add section</button>
          {secs.length >= MAX_SECTIONS && <span className="hint"> A project can have up to {MAX_SECTIONS} sections.</span>}
        </div>
      )}
      {secs && p && p.role !== "LEADER" && <p className="hint" style={{ marginTop: 16 }}>Only the Leader and Admins can change sections.</p>}

      {view === "list" && canWrite && sel.size > 0 && p && secs && (
        <BulkBar projectId={id} ids={[...sel]} versions={Object.fromEntries([...sel].map((t) => [t, versionOf(t)]))} people={p.members} sections={secs} onClear={() => setSel(new Set())}
          onDone={(r) => { setBulk(r); setSel(new Set()); refresh(); }} />
      )}
      {viewDialog && <SaveViewDialog kind={viewDialog} projectId={id} state={ls} view={activeView} onClose={() => setViewDialog(null)}
        onDone={(afterDelete) => { setViewDialog(null); vw.reload(); if (afterDelete) router.replace(urlWith({ assignee: null, f: null, priority: null, sort: null, group: null }), { scroll: false }); }} />}
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
  const [due, setDue] = useState("");
  const [dateOpen, setDateOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form className={`quick-add-row${compact ? "" : " item"}`} style={compact ? { marginTop: 4 } : undefined} onSubmit={async (e) => {
      e.preventDefault();
      if (!v.trim() || !due) { setDateOpen(true); setErr(!due ? "Add a due date." : null); return; }
      setBusy(true);
      const r = await api("POST", `/api/projects/${projectId}/tasks`, { title: v.trim(), sectionId, dueDate: due });
      setBusy(false);
      if (r.ok) { setV(""); setDue(""); setErr(null); onAdded(); } else setErr(r.error ?? "Could not add the task.");
    }}>
      <input className="in" aria-label="Add a task" placeholder="+ Add a task" value={v} disabled={busy} onChange={(e) => setV(e.target.value)} style={compact ? { background: "transparent" } : { border: 0, padding: 0 }} />
      <button type="button" className="btn ghost sm" aria-expanded={dateOpen} onClick={() => setDateOpen(!dateOpen)}>Due date{due ? ` · ${dueLabel(due)}` : ""}</button>{dateOpen && <input className="in" aria-label="Due date" type="date" required value={due} disabled={busy} onChange={(e) => { setDue(e.target.value); if (e.target.value) setErr(null); }} />}
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
  const [collaborators, setCollaborators] = useState<string[]>([]);
  const [pendingPeople, setPendingPeople] = useState<WorkspaceTaskCandidate[]>([]);
  const [pendingCollaborators, setPendingCollaborators] = useState<WorkspaceTaskCandidate[]>([]);
  const [addAssignee, setAddAssignee] = useState(false);
  const [addCollaborators, setAddCollaborators] = useState<string[]>([]);
  const canAddPeople = p.role === "LEADER" && !p.archived;
  const remember = (person: WorkspaceTaskCandidate) => setPendingPeople(current => current.some(p => p.id === person.id) ? current : [...current, person]);
  const rememberCollaborator = (person: WorkspaceTaskCandidate) => setPendingCollaborators(current => current.some(p => p.id === person.id) ? current : [...current, person]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal className="approved-record-form" label="Add task" onClose={onClose}>
      <div className="record-form-heading"><h2>Add task</h2><button type="button" className="link" aria-label="Close Add task" onClick={onClose}>×</button></div>
      <form className="new-task-form" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const r = await api("POST", `/api/projects/${p.id}/tasks`, { title, sectionId: section, assigneeId: assignee || undefined, dueDate: due || null, priority, collaboratorIds: collaborators.filter((id) => id !== assignee), addAssigneeToProject: addAssignee, addCollaboratorsToProject: addCollaborators.filter(id => collaborators.includes(id) && id !== assignee) });
        setBusy(false);
        if (r.ok) onAdded(); else setErr(r.error ?? "Could not add the task.");
      }}>
        <Field label="Title">{(id) => <input id={id} className="in" value={title} required maxLength={500} autoFocus={finePointer()} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label="Section">{(id) => <select id={id} className="in" value={section} onChange={(e) => setSection(e.target.value)}>{p.sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</Field>
        <Field label="Assignee">{(id) => <select id={id} className="in" value={assignee} onChange={(e) => { setAssignee(e.target.value); setAddAssignee(pendingPeople.some(p => p.id === e.target.value && !p.isMember)); }}>{pendingPeople.filter(person => !workers.some(w => w.userId === person.id)).map(person => <option key={person.id} value={person.id}>{personText(person)} (will join project)</option>)}{workers.map((w) => <option key={w.userId} value={w.userId}>{personText(w)}</option>)}</select>}</Field>
        {canAddPeople && <WorkspaceTaskPerson projectId={p.id} purpose="assignee" whenSaved excludeIds={[assignee]} onChoose={async (person, addToProject) => { remember(person); setAssignee(person.id); setAddAssignee(addToProject); return { ok: true }; }} />}
        <Field label="Collaborators (optional)">{(id) => <select id={id} className="in" multiple value={collaborators.filter((id) => id !== assignee)} onChange={(e) => setCollaborators(Array.from(e.target.selectedOptions, (option) => option.value))}>{pendingCollaborators.filter(person => person.id !== assignee && !p.members.some(m => m.userId === person.id)).map(person => <option key={person.id} value={person.id}>{personText(person)} (will join project)</option>)}{p.members.filter((m) => m.active && m.userId !== assignee).map((m) => <option key={m.userId} value={m.userId}>{personText(m)}</option>)}</select>}</Field>
        {canAddPeople && <WorkspaceTaskPerson projectId={p.id} purpose="collaborator" whenSaved excludeIds={[assignee, ...collaborators]} onChoose={async (person, addToProject) => { rememberCollaborator(person); setCollaborators(current => current.includes(person.id) ? current : [...current, person.id]); if (addToProject) setAddCollaborators(current => current.includes(person.id) ? current : [...current, person.id]); return { ok: true }; }} />}
        <Field label="Due date">{(id) => <input id={id} className="in" type="date" required value={due} onChange={(e) => setDue(e.target.value)} />}</Field>
        <Field label="Priority">{(id) => <select id={id} className="in" value={priority} onChange={(e) => setPriority(e.target.value)}>{Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
        {err && <div className="err" role="alert">{err}</div>}
        <div className="actions"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !title.trim() || !due}>Add task</button></div>
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
