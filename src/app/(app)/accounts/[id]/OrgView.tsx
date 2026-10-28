"use client";
import Link from "next/link";
import { use, useState } from "react";
import { api, dueLabel, todayIST, useGet } from "@/components/api";
import { Confirm, Field, Modal } from "@/components/ui";
import { Page, useMe } from "../../Shell";
import "../scroll.css";

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
    <ul style={{ listStyle: "none", paddingLeft: 14, margin: "2px 0" }}>
      <li>
        {node.id === current ? <b aria-current="page" className="chip">{node.name}</b> : <Link href={`/accounts/${node.id}`}>{node.name}</Link>}
        {node.children.map((c) => <TreeView key={c.id} node={c} current={current} />)}
      </li>
    </ul>
  );
}

function ContactDialog({ orgId, contact, onClose, onDone }: { orgId: string; contact?: Contact; onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const team = useGet<{ people: { id: string; name: string }[] }>("/api/team");
  const [v, setV] = useState({ name: contact?.name ?? "", role: contact?.role ?? "", email: contact?.email ?? "", phone: contact?.phone ?? "" });
  const [known, setKnown] = useState<string[]>(contact ? contact.knownBy.map((k) => k.id) : [me.id]);
  const [err, setErr] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ id: string; orgId: string } | null>(null);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });
  async function save(force = false) {
    const body = { force, name: v.name, role: v.role || null, email: v.email || null, phone: v.phone || null, knownBy: known };
    const r = contact ? await api("PATCH", `/api/contacts/${contact.id}`, body) : await api("POST", `/api/orgs/${orgId}/contacts`, body);
    if (r.ok) onDone(); else { setErr(r.error ?? "Could not save."); setDuplicate(r.data?.needsConfirm === "duplicate" ? { id: r.data.existingId, orgId: r.data.organisationId } : null); }
  }
  return (
    <Modal onClose={onClose} label={contact ? "Edit contact" : "New contact"}>
      <h2>{contact ? "Edit contact" : "New contact"}</h2>
      <Field label="Name">{(id) => <input id={id} className="in" value={v.name} onChange={set("name")} />}</Field>
      <Field label="Role">{(id) => <input id={id} className="in" value={v.role} onChange={set("role")} />}</Field>
      <Field label="Email">{(id) => <input id={id} className="in" type="email" value={v.email} onChange={set("email")} />}</Field>
      <Field label="Phone">{(id) => <input id={id} className="in" value={v.phone} onChange={set("phone")} />}</Field>
      <fieldset style={{ border: 0, padding: 0, margin: "8px 0" }}>
        <legend style={{ fontSize: 13, fontWeight: 600 }}>Known by</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {team.data?.people.map((p) => (
            <label key={p.id} style={{ fontSize: 14 }}><input type="checkbox" checked={known.includes(p.id)} onChange={(e) => setKnown(e.target.checked ? [...known, p.id] : known.filter((x) => x !== p.id))} /> {p.name}</label>
          ))}
        </div>
      </fieldset>
      {err && <div className="err" role="alert">{err}</div>}
      {duplicate && <div className="actions"><a className="btn ghost" href={`/accounts/${duplicate.orgId}`}>Use this one</a><button className="btn ghost" onClick={() => save(true)}>Create anyway</button></div>}
      <div className="actions"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={!v.name.trim() || known.length === 0} onClick={() => save()}>Save</button></div>
    </Modal>
  );
}

function NoteForm({ org, onDone }: { org: Org; onDone: () => void }) {
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
    <div className="card" style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <select className="in" aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <input className="in" type="date" aria-label="Date" value={date} onChange={(e) => setDate(e.target.value)} />
        <select className="in" aria-label="Deal" value={deal} onChange={(e) => setDeal(e.target.value)}>
          <option value="">No deal</option>{org.deals.filter((d) => !d.archived).map((d) => <option key={d.projectId} value={d.projectId}>{d.name}</option>)}
        </select>
      </div>
      <textarea className="in" aria-label="Note" placeholder="What happened?" style={{ marginTop: 8 }} value={text} onChange={(e) => setText(e.target.value)} />
      {org.contacts.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, margin: "6px 0" }}>
          {org.contacts.map((c) => <label key={c.id} style={{ fontSize: 13 }}><input type="checkbox" checked={who.includes(c.id)} onChange={(e) => setWho(e.target.checked ? [...who, c.id] : who.filter((x) => x !== c.id))} /> {c.name}</label>)}
        </div>
      )}
      {err && <div className="err" role="alert">{err}</div>}
      <button className="btn sm" disabled={!text.trim()} onClick={save}>Add note</button>
    </div>
  );
}

export default function OrgView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const me = useMe();
  const { data, status, reload } = useGet<{ organisation: Org }>(`/api/orgs/${id}`);
  const [hist, setHist] = useState<H | null>(null);
  const [dlg, setDlg] = useState<null | { contact?: Contact }>(null);
  const [rm, setRm] = useState<Contact | null>(null);
  const o = data?.organisation;
  if (status === 404) return <Page title="This organisation isn't available"><div className="card empty"><Link href="/accounts">Back to Accounts</Link></div></Page>;
  async function archive() { if (o) { await api("POST", `/api/orgs/${id}/archive`, { archive: !o.archived }); reload(); } }
  async function showHistory() { const r = await api<{ items: H }>("GET", `/api/orgs/${id}/history`); if (r.ok) setHist(r.data.items); }
  return (
    <Page title={o?.name ?? "…"} sub={o && <span className="crumb"><Link href="/accounts">Accounts</Link>{o.path.slice(0, -1).map((p) => <span key={p.id}> / <Link href={`/accounts/${p.id}`}>{p.name}</Link></span>)}</span>}
      actions={o && <>
        <Link className="btn" href={`/deals/new?org=${o.id}`}>+ Deal</Link>
        {o.canEdit && <button className="btn ghost" onClick={archive}>{o.archived ? "Unarchive" : "Archive"}</button>}
        {me.orgRole !== "MEMBER" && <button className="btn ghost" onClick={showHistory}>History</button>}
      </>}>
      {o?.archived && <div className="err">This organisation is archived.</div>}
      {o && <p className="meta" style={{ justifyContent: "flex-start" }}>{o.kind && <span className="chip">{o.kind}</span>}{o.country && <span>{o.country}</span>}{o.createdBy && <span>Added by {o.createdBy}</span>}</p>}

      <div className="grp">Open deals</div>
      {o && o.deals.length === 0 && <div className="card empty">No deals you can see yet.</div>}
      {o && o.deals.length > 0 && (
        <div className="acct-scroll" tabIndex={0} role="region" aria-label="Open deals"><table className="tbl"><thead><tr><th>Deal</th><th>Role</th><th>Stage</th><th>Leader</th></tr></thead>
          <tbody>{o.deals.map((d) => <tr key={d.projectId}><td><Link href={`/projects/${d.projectId}`}>{d.name}</Link></td><td>{d.role}</td><td>{d.stage?.name ?? "—"} <span style={{ color: "var(--muted)" }}>{d.pipeline}</span></td><td>{d.leader?.name ?? "—"}</td></tr>)}</tbody></table></div>
      )}

      <div className="grp">Contacts</div>
      {o && !o.archived && <button className="btn sm" style={{ marginBottom: 8 }} onClick={() => setDlg({})}>+ Contact</button>}
      {o && o.contacts.length === 0 && <div className="card empty">No contacts yet.</div>}
      {o && o.contacts.length > 0 && (
        <div className="list">
          {o.contacts.map((c) => (
            <div key={c.id} className="item" style={{ alignItems: "flex-start" }}>
              <div className="t">
                <div><b>{c.name}</b>{c.role ? ` · ${c.role}` : ""}</div>
                <small style={{ display: "block" }}>{[c.email, c.phone].filter(Boolean).join(" · ") || "No email or phone"}</small>
                <small style={{ display: "block" }}>Known by: {c.knownBy.map((k) => <span key={k.id} className={k.active ? "chip" : "chip grey"} style={{ marginRight: 4 }} title={k.active ? undefined : "No longer active"}>{k.name}</span>)}</small>
                <small style={{ display: "block" }}>Last spoke: {c.lastSpoke ? dueLabel(c.lastSpoke) : "never"}</small>
              </div>
              {c.canEdit && !o.archived && <div className="meta"><button className="link" onClick={() => setDlg({ contact: c })}>Edit</button><button className="link" onClick={() => setRm(c)}>Remove</button></div>}
            </div>
          ))}
        </div>
      )}

      <div className="grp">Notes</div>
      {o && !o.archived && <NoteForm org={o} onDone={reload} />}
      {o && o.notes.length === 0 && <div className="card empty">No notes yet.</div>}
      {o && o.notes.length > 0 && (
        <div className="list">
          {o.notes.map((n) => (
            <div key={n.id} className="item" style={{ alignItems: "flex-start" }}>
              <div className="t">
                <div><span className="chip">{KIND[n.kind]}</span> {dueLabel(n.date)} · {n.author.name}{n.deal && <> · <Link href={`/projects/${n.deal.id}`}>{n.deal.name}</Link></>}</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{n.text}</div>
                {n.contacts.length > 0 && <small style={{ display: "block" }}>With {n.contacts.map((c) => c.name).join(", ")}</small>}
              </div>
              {n.canDelete && <button className="link" onClick={async () => { await api("DELETE", `/api/notes/${n.id}`); reload(); }}>Delete</button>}
            </div>
          ))}
        </div>
      )}

      <div className="grp">Tasks linked here</div>
      {o && o.tasks.length === 0 && <div className="card empty">No linked tasks you can see.</div>}
      {o && o.tasks.length > 0 && (
        <div className="list">{o.tasks.map((t) => (
          <Link key={t.id} href={`/projects/${t.project.id}?task=${t.id}`} className="item"><div className="t"><b style={t.done ? { textDecoration: "line-through" } : undefined}>{t.title}</b><small>{t.project.name} · {t.assignee}</small></div><span>{dueLabel(t.dueDate)}</span></Link>
        ))}</div>
      )}

      {o?.tree && <><div className="grp">Organisation tree</div><div className="card">{<TreeView node={o.tree} current={o.id} />}</div></>}
      {hist && <><div className="grp">History</div><div className="list">{hist.map((h) => <div key={h.id} className="row">{h.who} · {h.action} · {new Date(h.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</div>)}</div></>}

      {dlg && <ContactDialog orgId={id} contact={dlg.contact} onClose={() => setDlg(null)} onDone={() => { setDlg(null); reload(); }} />}
      {rm && <Confirm title="Remove contact?" yes="Remove" danger body={`${rm.name} is removed. You can undo this right after.`} onNo={() => setRm(null)} onYes={async () => { await api("DELETE", `/api/contacts/${rm.id}`); setRm(null); reload(); }} />}
    </Page>
  );
}
