"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { api, useGet } from "@/components/api";
import { LoadFailed, Skeleton } from "@/components/ui";
import { Page, roleLabel, useMe } from "../../Shell";

type Proj = { id?: string; name: string; href?: string | null; role?: string; openTasks?: number };

/** A hidden deal is generic text with no link. A visible project keeps /projects/<id>. */
export function personProjectHref(project: { id?: string; href?: string | null }): string | null {
  if (project.href === null || !project.id) return null;
  return `/projects/${project.id}`;
}
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
  // APL-2664 v1.2. Each failed read has its own plain message. A 403 is no access, except the
  // forced-password 403 (APL-2624). The shared client is unchanged, so this matches the error text
  // that client already returns for PASSWORD_CHANGE_REQUIRED. Mocked until PR #8 merges.
  const settled = !g.loading;
  const passwordChange = settled && g.status === 403 && g.error === "Set your own password first.";
  const denied = settled && g.status === 403 && !passwordChange;
  // AC5: a 401 shows no message and no Retry here. The global redirect stays in api(), and the
  // visible session-expired sentence is APL-2652.
  const expired = settled && g.status === 401;
  const missing = settled && g.status === 404;
  const serverFault = settled && (g.status === 500 || g.status === 502 || g.status === 503);
  const unreachable = settled && g.status === 0 && !!g.error;
  const p = denied || passwordChange || expired || missing ? undefined : g.data?.person;
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

  if (passwordChange) {
    return (
      <Page title="Set your own password" docTitle="Set your own password">
        <div className="pwbar" role="status">
          <span>Set your own password. The emailed one still works until you do.</span>
          <Link href="/profile">Change password</Link>
        </div>
      </Page>
    );
  }

  return (
    <Page title={p?.name ?? "Person"} sub={admin && p?.email ? `${p.email} · ${roleLabel(p.orgRole!)}` : undefined} docTitle={p?.name ?? "Person"}>
      {/* APL-2664 AC3: a member sees the name and shared projects only, so email and role stay off this line. */}
      <p><Link href="/team">← Back to Team</Link></p>
      {g.loading && <Skeleton />}
      {missing && <div className="err" role="alert">Not found</div>}
      {denied && <div className="card empty" role="alert">{"You don't have access to this person"}</div>}
      {serverFault && (
        <div className="card empty" role="alert">
          <p>Something went wrong, try again</p>
          <button className="btn" onClick={g.reload}>Retry</button>
        </div>
      )}
      {(unreachable || (g.error && !missing && !expired && !denied && !serverFault)) && <LoadFailed onRetry={g.reload} />}
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
                  {p.projects.map((x, i) => {
                    const href = personProjectHref(x);
                    return (
                      <tr key={x.id ?? `hidden-deal-${i}`}>
                        <td>{href ? <Link href={href}>{x.name}</Link> : x.name}</td>
                        {admin && <td>{ROLE[x.role ?? ""] ?? x.role}</td>}
                        {admin && <td>{x.openTasks}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Page>
  );
}
