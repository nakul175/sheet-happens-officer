"use client";
import Link from "next/link";
import { useMe } from "@/app/(app)/Shell";
import { useEffect, useState } from "react";
import { api, useGet } from "@/components/api";
import { Confirm, Field, Modal } from "@/components/ui";
import { screenViewHref, type ScreenFilters, type ViewScreen } from "@/lib/screen-view-state";
type Saved = { id: string; name: string; scope: string; projectId: string | null; owner: { id: string; name: string }; canEdit: boolean; href: string; state: ScreenFilters };
export function ScreenViews({ screen, state, selected }: { screen: ViewScreen; state: ScreenFilters; selected?: string }) {
  const me = useMe();
  const { data, error: loadError, reload } = useGet<{ views: Saved[] }>(me?.crm === false ? null : `/api/screen-views?screen=${screen}`);
  const [dialog, setDialog] = useState<{ view?: Saved } | null>(null);
  const [remove, setRemove] = useState<Saved | null>(null);
  const [error, setError] = useState<string | null>(null);
  const definition = data?.views.find(v => v.id === selected);
  const active = definition && JSON.stringify(definition.state) !== JSON.stringify(state) ? undefined : selected;
  const href = screenViewHref(screen, state, active);
  useEffect(() => {
    if (me?.crm === false) return;
    if (window.location.pathname + window.location.search !== href) window.history.replaceState(window.history.state, "", href);
  }, [href, me?.crm]);
  if (me?.crm === false) return null;
  return <section aria-label="Saved views" style={{ marginBottom: 12 }}>
    <div className="tabs" style={{ flexWrap: "wrap", gap: 8 }}>
      <nav aria-label="Saved views" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {data?.views.map(v => <span key={v.id} style={{ display: "inline-flex", flexWrap: "wrap", maxWidth: "100%", alignItems: "center", gap: 4 }}>
          <Link className="btn ghost sm" style={{ maxWidth: "100%", whiteSpace: "normal", overflowWrap: "anywhere" }} aria-current={active === v.id ? "page" : undefined} href={v.href}>{v.name}{v.scope !== "PRIVATE" ? ` · ${v.owner.name}` : ""}</Link>
          {v.canEdit && <><button className="btn ghost sm" aria-label={`Edit view ${v.name}`} onClick={() => setDialog({ view: v })}>Edit</button><button className="btn ghost sm" aria-label={`Delete view ${v.name}`} onClick={() => setRemove(v)}>Delete</button></>}
        </span>)}
      </nav>
      <button className="btn ghost sm" onClick={() => setDialog({})}>Save view</button>
    </div>
    {loadError && <p className="err" role="alert">Could not load saved views. <button className="btn ghost sm" onClick={reload}>Retry</button></p>}
    {error && <p className="err" role="alert">{error}</p>}
    {dialog && <ViewDialog screen={screen} state={state} view={dialog.view} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} />}
    {remove && <Confirm title={remove.scope === "PRIVATE" ? "Delete view?" : "Delete shared view for everyone?"} body={remove.scope === "PRIVATE" ? `Delete “${remove.name}”?` : `“${remove.name}” is shared. Everyone will lose this saved view. Records are unaffected.`} yes="Delete view" danger onNo={() => setRemove(null)} onYes={async () => {
      const r = await api("DELETE", `/api/screen-views/${remove.id}?confirmShared=true`);
      setRemove(null); if (r.ok) { setError(null); reload(); } else setError(r.error ?? "Could not delete the view.");
    }} />}
  </section>;
}
function ViewDialog({ screen, state, view, onClose, onDone }: { screen: ViewScreen; state: ScreenFilters; view?: Saved; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(view?.name ?? "");
  const [scope, setScope] = useState(view?.scope ?? "PRIVATE");
  const [projectId, setProjectId] = useState(view?.projectId ?? "");
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projects = useGet<{ projects: { id: string; name: string }[] }>(scope === "PROJECT" ? "/api/projects" : null);
  async function save() {
    setBusy(true); setError(null);
    const r = await api(view ? "PATCH" : "POST", view ? `/api/screen-views/${view.id}` : "/api/screen-views", { name, screen, scope, projectId: scope === "PROJECT" ? projectId : null, state: view && !replace ? view.state : state });
    setBusy(false); if (r.ok) onDone(); else setError(r.error ?? "Could not save the view.");
  }
  return <Modal label={view ? "Edit saved view" : "Save view"} onClose={onClose}>
    <h2>{view ? "Edit saved view" : "Save view"}</h2>
    <Field label="View name">{id => <input id={id} className="in" value={name} maxLength={40} onChange={e => setName(e.target.value)} />}</Field>
    <Field label="Share with">{id => <select id={id} className="in" value={scope} onChange={e => setScope(e.target.value)}><option value="PRIVATE">Only me</option><option value="WORKSPACE">Workspace</option><option value="PROJECT">Project members</option></select>}</Field>
    {scope === "PROJECT" && <Field label="Project">{id => <select id={id} className="in" value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">Choose a project</option>{projects.data?.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}</Field>}
    {view && <label style={{ display: "block", margin: "12px 0" }}><input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} /> Replace filters with the current screen</label>}
    <p className="hint">Sharing saves the filters. Each person still sees only records they may access. Up to 10 private views per screen and 20 shared views in the workspace.</p>
    {error && <p className="err" role="alert">{error}</p>}
    <div className="actions"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !name.trim() || (scope === "PROJECT" && !projectId)} onClick={save}>Save</button></div>
  </Modal>;
}
