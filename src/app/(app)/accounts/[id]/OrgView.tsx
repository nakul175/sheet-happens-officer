"use client";
import Link from "next/link";
import { use, useState } from "react";
import { api, dueLabel, todayIST, useGet } from "@/components/api";
import { Confirm, Field, Modal } from "@/components/ui";
import { Page, useMe } from "../../Shell";
import "../scroll.css";
import "../accounts-approved.css";
import "../forms-approved.css";
import { useSearchParams } from "next/navigation";

type Contact = { id: string; name: string; role: string | null; email: string | null; phone: string | null; canEdit: boolean; knownBy: { id: string; name: string; active: boolean }[]; lastSpoke: string | null };
type Note = { id: string; kind: string; date: string; text: string; author: { id: string; name: string }; deal: { id: string; name: string } | null; contacts: { id: string; name: string }[]; canDelete: boolean };
type Tree = { id: string; name: string; children: Tree[] };
type Org = {
  id: string; name: string; kind: string | null; country: string | null; archived: boolean; path: { id: string; name: string }[]; canEdit: boolean; createdBy: string | null;
  deals: { projectId: string; name: string; role: string; archived: boolean; stage: { name: string } | null; pipeline: string | null; leader: { name: string } | null }[];
  contacts: Contact[]; notes: Note[]; tree: Tree | null;
  tasks: { id: string; title: string; done: boolean; dueDate: string | null; assignee: string; project: { id: string; name: string; type: string } }[];
};
type H = { id: string; at: string; who: string; action: string }[];
const KIND: Record<string, string> = { MEETING: "Meeting", CALL: "Call", INTRODUCTION: "Introduction", OTHER: "Other" };

function TreeView({ node, current }: { node: Tree; current: string }) {
  return (
    <ul className="org-tree-list">
      <li>
        {node.id === current ? <b aria-current="page" className="org-tree-current">{node.name}</b> : <Link href={`/accounts/${node.id}`}>{node.name}</Link>}
        {node.children.map((c) => <TreeView key={c.id} node={c} current={current} />)}
      </li>
    </ul>
  );
}

export function OrganisationEdit({ organisation, onClose, onDone }: { organisation: Org; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(organisation.name);
  const [kind, setKind] = useState(organisation.kind ?? "");
  const [country, setCountry] = useState(organisation.country ?? "");
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    const r = await api("PATCH", `/api/orgs/${organisation.id}`, { name: name.trim(), kind: kind.trim() || null, country: country.trim() || null });
    if (r.ok) onDone(); else setErr(r.error ?? "Could not update the organisation.");
  }
  return (
    <Modal onClose={onClose} label="Edit organisation">
      <h2>Edit organisation</h2>
      <Field label="Organisation / client name">{(id) => <input id={id} className="in" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label="Organisation kind">{(id) => <input id={id} className="in" value={kind} onChange={(e) => setKind(e.target.value)} />}</Field>
      <Field label="Country">{(id) => <input id={id} className="in" value={country} onChange={(e) => setCountry(e.target.value)} />}</Field>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="actions"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={!name.trim()} onClick={save}>Save changes</button></div>
    </Modal>
  );
}

function ContactDialog({ orgId, contact, onClose, onDone }: { orgId: string; contact?: Contact; onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const team = useGet<{ people: { id: string; name: string }[] }>("/api/team");
  const [v, setV] = useState({ name: contact?.name ?? "", role: contact?.role ?? "", email: contact?.email ?? "", phone: contact?.phone ?? "" });
  const [known, setKnown] = useState<string[]>(contact ? contact.knownBy.map((k) => k.id) : [me.id]);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });
  async function save() {
    const body = { name: v.name, role: v.role || null, email: v.email || null, phone: v.phone || null, knownBy: known };
    const r = contact ? await api("PATCH", `/api/contacts/${contact.id}`, body) : await api("POST", `/api/orgs/${orgId}/contacts`, body);
    if (r.ok) onDone(); else setErr(r.error ?? "Could not save.");
  }
  return (
    <Modal className="approved-record-form" onClose={onClose} label={contact ? "Edit contact" : "New contact"}>
      <div className="record-form-heading"><h2>{contact ? "Edit contact" : "New contact"}</h2><button className="link" aria-label="Close contact" onClick={onClose}>×</button></div>
      <Field label="Name">{(id) => <input id={id} className="in" value={v.name} onChange={set("name")} />}</Field>
      <div className="record-form-row"><Field label="Role">{(id) => <input id={id} className="in" value={v.role} onChange={set("role")} />}</Field>
      <Field label="Email">{(id) => <input id={id} className="in" type="email" value={v.email} onChange={set("email")} />}</Field>
      </div><Field label="Phone">{(id) => <input id={id} className="in" value={v.phone} onChange={set("phone")} />}</Field>
      <fieldset style={{ border: 0, padding: 0, margin: "8px 0" }}>
        <legend style={{ fontSize: 13, fontWeight: 600 }}>Known by</legend><p className="hint">Choose at least one person.</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {team.data?.people.map((p) => (
            <label key={p.id} style={{ fontSize: 14 }}><input type="checkbox" checked={known.includes(p.id)} onChange={(e) => setKnown(e.target.checked ? [...known, p.id] : known.filter((x) => x !== p.id))} /> {p.name}</label>
          ))}
        </div>
      </fieldset>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="actions"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={!v.name.trim() || known.length === 0} onClick={save}>Save</button></div>
    </Modal>
  );
}

function NoteForm({ org, onDone, onClose }: { org: Org; onDone: () => void; onClose: () => void }) {
  const [kind, setKind] = useState("CALL");
  const [date, setDate] = useState(todayIST());
  const [text, setText] = useState("");
  const [deal, setDeal] = useState("");
  const [who, setWho] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    const r = await api("POST", `/api/orgs/${org.id}/notes`, { kind, date, text, projectId: deal || null, contactIds: who });
    if (r.ok) { setText(""); setWho([]); setDeal(""); setErr(null); onDone(); } else setErr(r.error ?? "Could not save the note.");
  }
  return (
    <Modal className="approved-record-form" label="Add note" onClose={onClose}>
      <div className="record-form-heading"><h2>Add note</h2><button className="link" aria-label="Close note" onClick={onClose}>×</button></div>
      <div className="record-form-row">
        <label>Type<select className="in" aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>Date<input className="in" type="date" aria-label="Date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      </div><label>Deal (optional)
        <select className="in" aria-label="Deal" value={deal} onChange={(e) => setDeal(e.target.value)}>
          <option value="">No deal</option>{org.deals.filter((d) => !d.archived).map((d) => <option key={d.projectId} value={d.projectId}>{d.name}</option>)}
        </select>
      </label>
      <label>Note<textarea className="in" aria-label="Note" placeholder="What happened?" style={{ marginTop: 8 }} value={text} onChange={(e) => setText(e.target.value)} /></label>
      {org.contacts.length > 0 && (
        <fieldset className="record-choices"><legend>Contacts (optional)</legend>
          {org.contacts.map((c) => <label key={c.id} style={{ fontSize: 13 }}><input type="checkbox" checked={who.includes(c.id)} onChange={(e) => setWho(e.target.checked ? [...who, c.id] : who.filter((x) => x !== c.id))} /> {c.name}</label>)}
        </fieldset>
      )}
      {err && <div className="err" role="alert">{err}</div>}
      <div className="actions"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={!text.trim()} onClick={save}>Add note</button></div>
    </Modal>
  );
}

export default function OrgView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const me = useMe();
  const search = useSearchParams();
  const requestedTab = search.get("tab") ?? "overview";
  const section = ["contacts", "notes", "tasks", "tree"].includes(requestedTab) ? requestedTab : "overview";
  const tabHref = (tab: string) => { const q = new URLSearchParams(search.toString()); if (tab === "overview") q.delete("tab"); else q.set("tab", tab); return `/accounts/${id}${q.size ? `?${q}` : ""}`; };
  const { data, status, loading, error, reload } = useGet<{ organisation: Org }>(`/api/orgs/${id}`);
  const [hist, setHist] = useState<H | null>(null);
  const [dlg, setDlg] = useState<null | { contact?: Contact }>(null);
  const [edit, setEdit] = useState(false);
  const [addingNote, setAddingNote] = useState(false);
  const [rm, setRm] = useState<Contact | null>(null);
  const o = data?.organisation;
  if (status === 404) return <Page title="This organisation isn't available"><div className="card empty"><Link href="/accounts">Back to Accounts</Link></div></Page>;
  async function archive() { if (o) { await api("POST", `/api/orgs/${id}/archive`, { archive: !o.archived }); reload(); } }
  async function showHistory() { const r = await api<{ items: H }>("GET", `/api/orgs/${id}/history`); if (r.ok) setHist(r.data.items); }
  return (
    <Page className="accounts-approved org-detail-approved" title={o?.name ?? "…"} sub={o && <span className="crumb"><Link href="/accounts">Accounts</Link>{o.path.slice(0, -1).map((p) => <span key={p.id}> / <Link href={`/accounts/${p.id}`}>{p.name}</Link></span>)}</span>}
      actions={o && <>
        <Link className="btn" href={`/deals/new?org=${o.id}`}>+ New deal</Link>
        {o.canEdit && !o.archived && <button className="btn ghost" onClick={() => setEdit(true)}>Edit organisation</button>}
        {(o.canEdit || me.orgRole !== "MEMBER") && <details className="org-more" onKeyDown={e => { if (e.key === "Escape") { e.currentTarget.open = false; e.currentTarget.querySelector("summary")?.focus(); } }}><summary className="btn ghost">More</summary><div className="org-more-actions">
          {o.canEdit && <button className="btn ghost" onClick={archive}>{o.archived ? "Unarchive" : "Archive"}</button>}
          {me.orgRole !== "MEMBER" && <button className="btn ghost" onClick={showHistory}>History</button>}
        </div></details>}
      </>}>
      {loading && !o && <p role="status">Loading organisation…</p>}
      {error && <div className="err" role="alert">{error}<button className="btn ghost" onClick={reload}>Retry</button></div>}
      {o?.archived && <div className="err">This organisation is archived.</div>}
      {o && <p className="meta" style={{ justifyContent: "flex-start" }}>{o.kind && <span >{o.kind}</span>}{o.country && <span>{o.country}</span>}{o.createdBy && <span>Added by {o.createdBy}</span>}</p>}

      {o && <nav className="org-tabs" aria-label="Organisation sections">{[["overview", "Overview"], ["contacts", `Contacts ${o.contacts.length}`], ["notes", `Notes ${o.notes.length}`], ["tasks", `Linked tasks ${o.tasks.length}`], ["tree", "Organisation tree"]].map(([key, label]) => <Link key={key} href={tabHref(key)} aria-current={section === key ? "page" : undefined} scroll={false}>{label}</Link>)}</nav>}
      <section hidden={section !== "overview"} aria-label="Overview">
      <div className="org-overview-panel"><h2>Open deals {o && `(${o.deals.length})`}</h2>
      {o && o.deals.length === 0 && <div className="card empty">No deals you can see yet.</div>}
      {o && o.deals.length > 0 && (
        <div className="acct-scroll" tabIndex={0} role="region" aria-label="Open deals"><table className="tbl"><thead><tr><th>Deal</th><th>Relationship</th><th>Stage</th><th>Leader</th></tr></thead>
          <tbody>{o.deals.map((d) => <tr key={d.projectId}><td><Link href={`/projects/${d.projectId}`}>{d.name}</Link></td><td>{d.role}</td><td>{d.stage?.name ?? "—"} <span style={{ color: "var(--muted)" }}>{d.pipeline}</span></td><td>{d.leader?.name ?? "—"}</td></tr>)}</tbody></table></div>
      )}

      </div>
      {o && <div className="org-previews"><section className="org-overview-panel" aria-label="Contacts preview"><div className="org-preview-heading"><h2>Contacts ({o.contacts.length})</h2><Link href={tabHref("contacts")} scroll={false}>View contacts</Link></div>{o.contacts.slice(0, 3).map(c => <div key={c.id} className="org-preview-row"><strong>{c.name}</strong><small>{c.role ?? "—"}</small></div>)}{!o.contacts.length && <p className="org-preview-row">No contacts yet.</p>}</section><section className="org-overview-panel" aria-label="Linked tasks preview"><div className="org-preview-heading"><h2>Linked tasks ({o.tasks.length})</h2><Link href={tabHref("tasks")} scroll={false}>View tasks</Link></div>{o.tasks.slice(0, 3).map(t => <Link key={t.id} className="org-preview-row" href={`/projects/${t.project.id}?task=${t.id}`}><strong style={t.done ? { textDecoration: "line-through" } : undefined}>{t.title}</strong><small>{t.project.name} · {t.assignee} · {dueLabel(t.dueDate)}</small></Link>)}{!o.tasks.length && <p className="org-preview-row">No linked tasks you can see.</p>}</section></div>}
      </section>
      <section hidden={section !== "contacts"} aria-label="Contacts">
      <div className="org-overview-panel org-contacts-panel">
      <div className="org-preview-heading"><h2>Contacts</h2>{o && !o.archived && <button className="btn" onClick={() => setDlg({})}>+ Contact</button>}</div>
      {o && o.contacts.length === 0 && <div className="card empty">No contacts yet.</div>}
      {o && o.contacts.length > 0 && <div className="acct-scroll" tabIndex={0} role="region" aria-label="Organisation contacts"><table className="tbl"><thead><tr><th>Contact</th><th>Contact details</th><th>Known by</th><th>Last spoke</th><th>Actions</th></tr></thead><tbody>{o.contacts.map(c => <tr key={c.id}>
        <td><strong>{c.name}</strong>{c.role && <small className="contact-secondary">{c.role}</small>}</td>
        <td><span className="contact-secondary">{c.email ?? "No email"}</span><span className="contact-secondary">{c.phone ?? "No phone"}</span></td>
        <td>{c.knownBy.map(k => <span key={k.id} className="contact-secondary">{k.name}{!k.active && <span className="contact-inactive"> · inactive</span>}</span>)}</td>
        <td>{c.lastSpoke ? dueLabel(c.lastSpoke) : "Never"}</td>
        <td>{c.canEdit && !o.archived && <div className="contact-actions"><button className="link" aria-label={`Edit ${c.name}`} onClick={() => setDlg({ contact: c })}>Edit</button><button className="link contact-remove" aria-label={`Remove ${c.name}`} onClick={() => setRm(c)}>Remove</button></div>}</td>
      </tr>)}</tbody></table></div>}
      </div>

      </section><section hidden={section !== "notes"} aria-label="Notes">
      <div className="org-overview-panel org-notes-panel"><div className="org-preview-heading"><h2>Notes</h2>{o && !o.archived && <button className="btn" aria-expanded={addingNote} aria-controls="org-note-form" onClick={() => setAddingNote(!addingNote)}>{addingNote ? "Cancel note" : "+ Add note"}</button>}</div>
      {o && !o.archived && addingNote && <div id="org-note-form"><NoteForm org={o} onDone={reload} onClose={() => setAddingNote(false)} /></div>}
      {o && o.notes.length === 0 && <div className="card empty">No notes yet.</div>}
      {o && o.notes.length > 0 && (
        <div className="org-notes-feed">
          {o.notes.map((n) => (
            <div key={n.id} className="item" style={{ alignItems: "flex-start" }}>
              <div className="t">
                <div><span className="note-kind">{KIND[n.kind]}</span> {dueLabel(n.date)} · {n.author.name}{n.deal && <> · <Link href={`/projects/${n.deal.id}`}>{n.deal.name}</Link></>}</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{n.text}</div>
                {n.contacts.length > 0 && <small style={{ display: "block" }}>With {n.contacts.map((c) => c.name).join(", ")}</small>}
              </div>
              {n.canDelete && <button className="link" aria-label={`Delete ${KIND[n.kind]} note by ${n.author.name}`} onClick={async () => { await api("DELETE", `/api/notes/${n.id}`); reload(); }}>Delete</button>}
            </div>
          ))}
        </div>
      )}

      </div></section><section hidden={section !== "tasks"} aria-label="Linked tasks">
      <div className="org-overview-panel"><h2>Linked tasks {o && `(${o.tasks.length})`}</h2>
      {o && o.tasks.length === 0 && <div className="card empty">No linked tasks you can see.</div>}
      {o && o.tasks.length > 0 && <div className="acct-scroll" tabIndex={0} role="region" aria-label="Linked tasks table"><table className="tbl"><thead><tr><th>Task</th><th>Project</th><th>Assignee</th><th>Due date</th></tr></thead><tbody>{o.tasks.map(t => <tr key={t.id}><td><Link href={`/projects/${t.project.id}?task=${t.id}`} style={t.done ? { textDecoration: "line-through" } : undefined}>{t.title}</Link>{t.done && <small className="contact-secondary">Completed</small>}</td><td><Link href={`/projects/${t.project.id}`}>{t.project.name}</Link></td><td>{t.assignee}</td><td>{dueLabel(t.dueDate)}</td></tr>)}</tbody></table></div>}
      </div>

      </section><section hidden={section !== "tree"} aria-label="Organisation tree">
      {o && !o.tree && <p>No organisation tree available.</p>}
      {o?.tree && <div className="org-overview-panel"><h2>Organisation structure</h2><div className="org-tree-scroll" tabIndex={0} role="region" aria-label="Organisation hierarchy"><TreeView node={o.tree} current={o.id} /></div></div>}
      </section>
      {hist && <><div className="grp">History</div><div className="list">{hist.map((h) => <div key={h.id} className="row">{h.who} · {h.action} · {new Date(h.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</div>)}</div></>}

      {dlg && <ContactDialog orgId={id} contact={dlg.contact} onClose={() => setDlg(null)} onDone={() => { setDlg(null); reload(); }} />}
      {edit && o && <OrganisationEdit organisation={o} onClose={() => setEdit(false)} onDone={() => { setEdit(false); reload(); }} />}
      {rm && <Confirm title="Remove contact?" yes="Remove" danger body={`${rm.name} is removed. You can undo this right after.`} onNo={() => setRm(null)} onYes={async () => { await api("DELETE", `/api/contacts/${rm.id}`); setRm(null); reload(); }} />}
    </Page>
  );
}
