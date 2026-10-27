"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { ROLE, api, useGet } from "@/components/api";
import { Confirm, Field, LoadFailed, Skeleton } from "@/components/ui";
import { Page, useMe } from "../../../Shell";

type M = { userId: string; name: string; role: string; active: boolean; email?: string };
type Proj = { id: string; name: string; archived: boolean; role: string; type?: string; isVertical?: boolean; verticalId?: string | null; members: M[] };
type Person = { id: string; name: string; email?: string; status?: "ACTIVE" | "UNVERIFIED" | "DEACTIVATED" };

export default function Members({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const admin = useMe().orgRole !== "MEMBER";
  const verticals = useGet<{ verticals: { id: string; name: string; retired: boolean }[] }>("/api/verticals");
  const [classify, setClassify] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const pr = useGet<{ project: Proj }>(`/api/projects/${id}`);
  const team = useGet<{ people: Person[] }>("/api/team");
  const [q, setQ] = useState("");
  const [addRole, setAddRole] = useState("EDITOR");
  const [err, setErr] = useState<string | null>(null);
  const [dlg, setDlg] = useState<null | { kind: "remove" | "viewer" | "leader" | "archive" | "delete"; m?: M }>(null);
  const p = pr.data?.project;
  if (!p && pr.failed) return <Page title="Members"><LoadFailed onRetry={pr.reload} /></Page>;
  if (pr.error && !p) return <Page title="This project isn't available"><div className="card empty">It may not exist, or you are not a member.<br /><Link href="/projects">Back to Projects</Link></div></Page>;
  const manage = p?.role === "LEADER" && !p?.archived;
  const inProject = new Set(p?.members.map((m) => m.userId));
  const found = q.trim().length < 1 ? [] : (team.data?.people ?? []).filter((x) => (!x.status || x.status === "ACTIVE") && !inProject.has(x.id) && (x.name + " " + (x.email ?? "")).toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8);

  async function add(userId: string) {
    const r = await api("POST", `/api/projects/${id}/members`, { userId, role: addRole });
    if (r.ok) { setErr(null); setQ(""); pr.reload(); } else setErr(r.error ?? "Could not add.");
  }
  async function setRole(m: M, role: string) {
    if (role === "VIEWER") { setDlg({ kind: "viewer", m }); return; }
    const r = await api("PATCH", `/api/projects/${id}/members/${m.userId}`, { role });
    if (r.ok) { setErr(null); } else setErr(r.error ?? "Could not change the role.");
    pr.reload();
  }
  const takers = (without: string) => (p?.members ?? []).filter((m) => m.active && m.userId !== without && (m.role === "LEADER" || m.role === "EDITOR"));
  const leaderM = p?.members.find((m) => m.role === "LEADER");

  return (
    <Page title="Members" sub={p && <><Link href={`/projects/${id}`}>← {p.name}</Link> · <span className="chip">You: {ROLE[p.role]}</span></>}>
      {err && <div className="err" role="alert">{err}</div>}
      {p?.archived && <div className="box warn" style={{ marginBottom: 12 }}>This project is archived and read-only.</div>}
      {pr.loading && !p && <Skeleton />}
      <div className="list">
        {p?.members.map((m) => (
          <div className="item" key={m.userId}>
            <div className="t"><b>{m.name}{!m.active && " (deactivated)"}</b>{m.email && <small>{m.email}</small>}</div>
            <span className="vlab" aria-hidden>Role</span>
            {manage && m.role !== "LEADER" ? (
              <select className="in" style={{ width: "auto" }} aria-label={`Role of ${m.name}`} value={m.role} onChange={(e) => setRole(m, e.target.value)}>
                <option value="EDITOR">Editor</option><option value="VIEWER">Viewer</option>
              </select>
            ) : <span className="chip">{ROLE[m.role]}</span>}
            {manage && m.role !== "LEADER" && <button className="btn ghost sm" onClick={() => setDlg({ kind: "remove", m })}>Remove</button>}
          </div>
        ))}
      </div>
      {manage && (
        <>
          <h2 className="grp">Project settings</h2>
          {p && p.type !== "DEAL" && <div className="box">
            <b>{p.isVertical ? "Vertical task board" : "Delivery project"}</b>
            {!p.isVertical && <label>Vertical (optional) <select value={p.verticalId ?? ""} onChange={async e => { const result = await api("PATCH", `/api/projects/${id}`, { verticalId: e.target.value || null }); if (!result.ok) setErr(result.error ?? "Could not change vertical."); pr.reload(); }}>
              <option value="">Unclassified</option>{verticals.data?.verticals?.filter(v => !v.retired || v.id === p.verticalId).map(v => <option key={v.id} value={v.id}>{v.name}{v.retired ? " (retired)" : ""}</option>)}
            </select></label>}
            <p className="hint">This classification does not add members or change access.</p>
            {admin && <button className="btn ghost sm" onClick={() => setClassify(true)}>{p.isVertical ? "Reclassify as delivery project…" : "Reclassify as vertical board…"}</button>}
          </div>}
          <div className="box">
            <b>Change leader</b>
            <p className="hint">The new Leader takes over. Choose what happens to the current Leader.</p>
            <button className="btn ghost sm" onClick={() => setDlg({ kind: "leader" })}>Change leader…</button>
          </div>
          <div className="box">
            <b>Add people</b>
            <div className="addrow">
              <input className="in" aria-label="Search by name or email" placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} />
              <select className="in" style={{ width: "auto" }} aria-label="Role for new member" value={addRole} onChange={(e) => setAddRole(e.target.value)}>
                <option value="EDITOR">Editor</option><option value="VIEWER">Viewer</option>
              </select>
            </div>
            {found.map((x) => (
              <div className="item" key={x.id}><div className="t"><b>{x.name}</b>{x.email && <small>{x.email}</small>}</div><button className="btn sm" onClick={() => add(x.id)}>Add</button></div>
            ))}
            {q.trim() && !found.length && <p className="hint">No one matches, or they are already in this project.</p>}
          </div>
        </>
      )}
      {p && (p.role === "LEADER") && (!p.isVertical || admin) && (
        <div className="box dng">
          <b>{p.archived ? "Unarchive this project" : "Archive this project"}</b>
          <p className="hint">{p.archived ? "It becomes editable again." : "It becomes read-only. Everyone with an open task is told. You can unarchive it later."}</p>
          <button className="btn ghost sm" style={{ color: "var(--danger)" }} onClick={() => setDlg({ kind: "archive" })}>{p.archived ? "Unarchive…" : "Archive…"}</button>
        </div>
      )}
      {p?.role === "LEADER" && (!p.isVertical || admin) && <div className="box dng">
        <b>Delete {p.type === "DEAL" ? "deal" : "project"}</b>
        <p className="hint">Move this {p.type === "DEAL" ? "deal" : "project"} to Trash. Tasks, notes, people and history are kept. A Leader or Admin can restore it later. Nothing is permanently deleted.</p>
        <button className="btn ghost sm" onClick={() => setDlg({ kind: "delete" })}>Delete {p.type === "DEAL" ? "deal" : "project"}…</button>
      </div>}

      {dlg && (dlg.kind === "remove" || dlg.kind === "viewer") && dlg.m && (
        <Handover title={dlg.kind === "remove" ? `Remove ${dlg.m.name}?` : `Make ${dlg.m.name} a Viewer?`} yes={dlg.kind === "remove" ? "Remove" : "Make Viewer"} danger={dlg.kind === "remove"}
          who={dlg.m.name} options={takers(dlg.m.userId)} defaultTo={leaderM?.userId}
          onClose={() => setDlg(null)}
          onGo={(to) => dlg.kind === "remove" ? api("DELETE", `/api/projects/${id}/members/${dlg.m!.userId}?handoverTo=${to}`) : api("PATCH", `/api/projects/${id}/members/${dlg.m!.userId}`, { role: "VIEWER", handoverTo: to })}
          onDone={() => { setDlg(null); pr.reload(); }} />
      )}
      {dlg?.kind === "leader" && p && <ChangeLeader p={p} id={id} onClose={() => setDlg(null)} onDone={() => { setDlg(null); pr.reload(); }} />}
      {dlg?.kind === "archive" && p && <Archive id={id} archived={p.archived} onClose={() => setDlg(null)} onDone={() => { setDlg(null); pr.reload(); }} />}
      {dlg?.kind === "delete" && p && <DeleteProject id={id} name={p.name} kind={p.type === "DEAL" ? "deal" : "project"} onClose={() => setDlg(null)} />}
      {classify && p && <Confirm title={`Reclassify “${p.name}”?`} yes="Reclassify" body={`It becomes a ${p.isVertical ? "delivery project" : "vertical task board"}. Existing tasks, URLs, members and permissions stay unchanged. ${p.isVertical ? "Linked delivery projects must be reassigned first." : "Its current vertical link is cleared."}`} busy={classifying} error={err} onNo={() => setClassify(false)} onYes={async () => {
        setClassifying(true); const result = await api("POST", `/api/projects/${id}/classification`, { isVertical: !p.isVertical }); setClassifying(false);
        if (result.ok) { setClassify(false); pr.reload(); verticals.reload(); } else setErr(result.error ?? "Could not reclassify.");
      }} />}
    </Page>
  );
}

export function DeleteProject({ id, name, kind = "project", onClose }: { id: string; name: string; kind?: "project" | "deal"; onClose: () => void }) {
  const router = useRouter();
  const [confirmationName, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <Confirm title={`Delete ${kind} “${name}”?`} yes="Move to Trash" danger busy={busy || confirmationName !== name} error={error} onNo={onClose}
    body={`This ${kind} and its work disappear from active views. All tasks, subtasks, notes, links, memberships and history are retained. Restore from ${kind === "deal" ? "Deals" : "Projects"} → Trash; there is no automatic permanent deletion. Members are notified.`}
    onYes={async () => { setBusy(true); const result = await api("POST", `/api/projects/${id}/delete`, { confirmationName }); setBusy(false); if (result.ok) router.push(kind === "deal" ? "/deals" : "/projects"); else setError(result.error ?? `Could not delete ${kind}.`); }}>
    <Field label={`Type the exact ${kind} name`}>{inputId => <input id={inputId} className="in" value={confirmationName} onChange={e => setName(e.target.value)} />}</Field>
  </Confirm>;
}

function Handover({ title, yes, danger, who, options, defaultTo, onClose, onGo, onDone }: {
  title: string; yes: string; danger?: boolean; who: string; options: M[]; defaultTo?: string;
  onClose: () => void; onGo: (to: string) => Promise<{ ok: boolean; error?: string }>; onDone: () => void;
}) {
  const [to, setTo] = useState(defaultTo ?? options[0]?.userId ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Confirm title={title} yes={yes} danger={danger} busy={busy || !to} error={err} onNo={onClose}
      body={`Any open tasks ${who} holds must go to someone. Choose who takes them.`}
      onYes={async () => { setBusy(true); const r = await onGo(to); setBusy(false); if (r.ok) onDone(); else setErr(r.error ?? "Could not do that."); }}>
      <Field label="Who takes their tasks?">{(id) => <select id={id} className="in" value={to} onChange={(e) => setTo(e.target.value)}>{options.map((o) => <option key={o.userId} value={o.userId}>{o.name}</option>)}</select>}</Field>
    </Confirm>
  );
}

function ChangeLeader({ p, id, onClose, onDone }: { p: Proj; id: string; onClose: () => void; onDone: () => void }) {
  const cands = p.members.filter((m) => m.active && m.role !== "LEADER");
  const [next, setNext] = useState(cands[0]?.userId ?? "");
  const [prev, setPrev] = useState("EDITOR");
  const [taker, setTaker] = useState("");
  const takers = p.members.filter((m) => m.active && m.role !== "VIEWER" && m.role !== "LEADER");
  const needsTaker = prev === "VIEWER" || prev === "REMOVE";
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Confirm title="Change leader" yes="Change leader" busy={busy || !next} error={err} onNo={onClose}
      body="The new Leader is told. The current Leader keeps the role you choose here."
      onYes={async () => {
        setBusy(true);
        const r = await api("POST", `/api/projects/${id}/leader`, { newLeaderId: next, previousRole: prev, handoverTo: needsTaker && taker ? taker : next });
        setBusy(false);
        if (r.ok) onDone(); else setErr(r.error ?? "Could not change the leader.");
      }}>
      {!cands.length ? <p className="hint">Add another member first. A Leader must come from the project&apos;s members.</p> : (
        <>
          <Field label="New leader">{(i) => <select id={i} className="in" value={next} onChange={(e) => setNext(e.target.value)}>{cands.map((m) => <option key={m.userId} value={m.userId}>{m.name} ({ROLE[m.role]})</option>)}</select>}</Field>
          <Field label="The current Leader becomes" hint={needsTaker ? "Choose who takes their open tasks. The default is the new Leader." : undefined}>
            {(i) => <select id={i} className="in" value={prev} onChange={(e) => setPrev(e.target.value)}><option value="EDITOR">Editor</option><option value="VIEWER">Viewer</option><option value="REMOVE">Removed from the project</option></select>}
          </Field>
          {needsTaker && (
            <Field label="Who takes their open tasks?">
              {(i) => <select id={i} className="in" value={taker || next} onChange={(e) => setTaker(e.target.value)}>
                {[...takers.filter((m) => m.userId === next), ...takers.filter((m) => m.userId !== next)].map((m) => <option key={m.userId} value={m.userId}>{m.name} ({ROLE[m.role]}){m.userId === next ? ", new Leader" : ""}</option>)}
              </select>}
            </Field>
          )}
        </>
      )}
    </Confirm>
  );
}

function Archive({ id, archived, onClose, onDone }: { id: string; archived: boolean; onClose: () => void; onDone: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const list = useGet<{ projects: { id: string; openTasks: number }[] }>(archived ? null : "/api/projects");
  const open = list.data?.projects.find((x) => x.id === id)?.openTasks;
  const [busy, setBusy] = useState(false);
  return (
    <Confirm title={archived ? "Unarchive this project?" : "Archive this project?"} yes={archived ? "Unarchive" : "Archive"} danger={!archived} busy={busy} error={err} onNo={onClose}
      body={archived ? "The project becomes editable again." : `Nobody can change anything while it is archived. ${open === undefined ? "" : `${open} open task${open === 1 ? "" : "s"}: `}everyone with an open task is told.`}
      onYes={async () => { setBusy(true); const r = await api("POST", `/api/projects/${id}/${archived ? "unarchive" : "archive"}`, {}); setBusy(false); if (r.ok) onDone(); else setErr(r.error ?? "Could not do that."); }} />
  );
}
