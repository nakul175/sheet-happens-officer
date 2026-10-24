"use client";
import { useState } from "react";
import { ago, api, useGet } from "@/components/api";
import { Field } from "@/components/ui";
import { Page, SignOut, roleLabel, useMe } from "../Shell";

type Sess = { id: string; device: string; lastActive: string; current: boolean };

export default function Profile() {
  const me = useMe();
  const ses = useGet<{ sessions: Sess[] }>("/api/profile/sessions");
  const [name, setName] = useState(me.name);
  const [nameMsg, setNameMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cur, setCur] = useState(""); const [pw, setPw] = useState(""); const [conf, setConf] = useState("");
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [outMsg, setOutMsg] = useState<string | null>(null);

  return (
    <Page title="Profile" sub={`${me.email} · ${roleLabel(me.orgRole)}`}>
      <div style={{ display: "grid", gap: 16, maxWidth: 620 }}>
        <form className="card" onSubmit={async (e) => {
          e.preventDefault();
          const r = await api("PATCH", "/api/profile", { name });
          setNameMsg(r.ok ? { ok: true, text: "Saved. Your new name shows after the page reloads." } : { ok: false, text: r.error ?? "Could not save." });
        }}>
          <h2 style={{ margin: "0 0 12px", fontSize: 17 }}>Profile</h2>
          <Field label="Name">{(id) => <input id={id} className="in" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Email" hint="Your email is your sign-in and cannot be changed here.">{(id) => <input id={id} className="in" value={me.email} readOnly />}</Field>
          {nameMsg && <div className={nameMsg.ok ? "ok" : "err"} role="status">{nameMsg.text}</div>}
          <button className="btn" disabled={!name.trim() || name.trim() === me.name}>Save name</button>
        </form>

        <form className="card" onSubmit={async (e) => {
          e.preventDefault();
          const r = await api("POST", "/api/profile/password", { current: cur, password: pw, confirm: conf });
          if (r.ok) { setPwMsg({ ok: true, text: "Password changed. You were signed out of your other devices." }); setCur(""); setPw(""); setConf(""); ses.reload(); }
          else setPwMsg({ ok: false, text: r.error ?? "Could not change the password." });
        }}>
          <h2 style={{ margin: "0 0 12px", fontSize: 17 }}>Change password</h2>
          <Field label="Current password">{(id) => <input id={id} className="in" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />}</Field>
          <Field label="New password" hint="At least 8 characters, with a letter and a number.">{(id) => <input id={id} className="in" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
          <Field label="Confirm new password">{(id) => <input id={id} className="in" type="password" autoComplete="new-password" value={conf} onChange={(e) => setConf(e.target.value)} />}</Field>
          {pwMsg && <div className={pwMsg.ok ? "ok" : "err"} role="status">{pwMsg.text}</div>}
          <button className="btn" disabled={!cur || !pw || !conf}>Change password</button>
        </form>

        <section className="card">
          <h2 style={{ margin: "0 0 12px", fontSize: 17 }}>Where you are signed in</h2>
          {ses.data?.sessions.map((s) => (
            <div className="item" key={s.id} style={{ padding: "8px 0" }}>
              <div className="t"><b>{s.device}</b><small>Last active {ago(s.lastActive)}</small></div>
              {s.current && <span className="chip green">This device</span>}
            </div>
          ))}
          {outMsg && <div className="ok" role="status">{outMsg}</div>}
          <p className="hint">Sessions last 30 days. Changing your password signs you out everywhere else.</p>
          <div className="pills">
            <SignOut />
            <button className="btn ghost" disabled={(ses.data?.sessions.length ?? 0) < 2} onClick={async () => {
              const r = await api("POST", "/api/profile/sessions/sign-out-others", {});
              if (r.ok) { setOutMsg(`Signed out of ${r.data.signedOut} other device${r.data.signedOut === 1 ? "" : "s"}.`); ses.reload(); }
            }}>Sign out of all other devices</button>
            <button className="btn ghost" onClick={async () => {
              const r = await api("POST", "/api/profile/sessions/sign-out-all", {});
              if (r.ok) window.location.href = "/signin";
            }}>Sign out everywhere</button>
          </div>
        </section>
      </div>
    </Page>
  );
}
