"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { api, useGet } from "@/components/api";
import { LoadFailed } from "@/components/ui";
import { Page, roleLabel, useMe } from "../../Shell";

type Proj = { id: string; name: string; role?: string; openTasks?: number };
type Person = {
  id: string; name: string; projects: Proj[];
  email?: string; orgRole?: "MEMBER" | "ADMIN" | "SUPER_ADMIN"; status?: "ACTIVE" | "UNVERIFIED" | "DEACTIVATED"; joinedAt?: string; openTasks?: number;
};
const ROLE: Record<string, string> = { LEADER: "Leader", EDITOR: "Member", VIEWER: "Viewer" };

// SHO-US-15.4. A Member gets a name and shared projects; Admins get the rest.
export default function PersonPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const g = useGet<{ person: Person }>(`/api/team/${id}`);
  const [note, setNote] = useState<null | { ok: boolean; text: string }>(null);
  const p = g.data?.person;
  const admin = me.orgRole !== "MEMBER";
  const self = p?.id === me.id;

  async function resend() {
    if (!p) return;
    const r = await api<{ emailSent: boolean }>("POST", `/api/team/${p.id}/resend`, {});
    if (!r.ok) setNote({ ok: false, text: r.error ?? "Could not resend." });
    else setNote(r.data.emailSent ? { ok: true, text: `New sign-in details were emailed to ${p.email}.` } : { ok: false, text: "The password was changed but the email did not send. Press the button again." });
  }
  async function role(to: "ADMIN" | "MEMBER") {
    if (!p) return;
    const r = await api("PATCH", `/api/team/${p.id}`, { orgRole: to });
    if (r.ok) { setNote({ ok: true, text: `${p.name} is now ${to === "ADMIN" ? "an Admin" : "a Member"}.` }); g.reload(); } else setNote({ ok: false, text: r.error ?? "Could not change the role." });
  }

  return (
    <Page title={p?.name ?? "Person"} sub={p?.email ? `${p.email} · ${roleLabel(p.orgRole!)}` : undefined} docTitle={p?.name ?? "Person"}>
      <p><Link href="/team">← Back to Team</Link></p>
      {g.loading && <div className="skel">Loading…</div>}
      {g.error && g.status === 404 && <div className="err" role="alert">This person was not found.</div>}
      {g.error && g.status !== 404 && <LoadFailed onRetry={g.reload} />}
      {note && <div className={note.ok ? "ok" : "err"} role="status">{note.text}</div>}
      {p && (
        <>
          {admin && (
            <div className="pills" style={{ margin: "8px 0 16px" }}>
              <span className={`chip${p.status === "ACTIVE" ? " green" : p.status === "UNVERIFIED" ? " gold" : " grey"}`}>{p.status === "ACTIVE" ? "Active" : p.status === "UNVERIFIED" ? "Unverified" : "Deactivated"}</span>
              <span className="hint">Joined {p.joinedAt && new Date(p.joinedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
              <span className="hint">·</span>
              <span className="hint">{p.openTasks} open task{p.openTasks === 1 ? "" : "s"}</span>
              {me.orgRole === "SUPER_ADMIN" && !self && p.orgRole !== "SUPER_ADMIN" && p.status !== "DEACTIVATED" && (
                <>
                  {p.orgRole === "ADMIN"
                    ? <button className="btn ghost sm" onClick={() => role("MEMBER")}>Make Member</button>
                    : <button className="btn ghost sm" onClick={() => role("ADMIN")}>Make Admin</button>}
                  <button className="btn ghost sm" onClick={resend}>Resend sign-in details</button>
                  <Link className="btn ghost sm" href="/team">Deactivate from the Team list</Link>
                </>
              )}
            </div>
          )}
          <h2 style={{ fontSize: 17 }}>{admin ? "Projects" : "Projects you share"}</h2>
          {p.projects.length === 0 && <p className="hint">{admin ? "Not on any project yet." : "You are not on a project together."}</p>}
          {p.projects.length > 0 && (
            <div className="scroll">
              <table className="tbl stack">
                <thead><tr><th>Project</th>{admin && <th>Their role</th>}{admin && <th>Open tasks</th>}</tr></thead>
                <tbody>
                  {p.projects.map((x) => (
                    <tr key={x.id}>
                      <td><Link href={`/projects/${x.id}`}>{x.name}</Link></td>
                      {admin && <td>{ROLE[x.role ?? ""] ?? x.role}</td>}
                      {admin && <td>{x.openTasks}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Page>
  );
}
