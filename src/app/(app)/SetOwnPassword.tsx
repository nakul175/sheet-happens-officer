"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthShell } from "@/components/AuthShell";
import styles from "@/components/auth.module.css";
import { post } from "@/components/client";
import { legacySignInHref, sessionSignInTarget } from "@/lib/return-to";

/** SHO-US-23.5. A wall, not a nudge: a Super-Admin-issued password must be replaced before anything else opens. */
export function SetOwnPassword({ email }: { email: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { document.title = "Set your own password · Sheet Happens Officer"; }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const r = await post("/api/profile/password", { current: f.get("current"), password: f.get("password"), confirm: f.get("confirm") });
    if (r.ok) { router.refresh(); return; } // same URL: the page they asked for now opens
    setBusy(false);
    // APL-2652 AC6: a 401 here goes to /signin?expired=1 with this page as next, the same as api(). Flag off is plain /signin.
    if (r.status === 401) { router.replace(sessionSignInTarget(window.location.pathname, window.location.search) ?? legacySignInHref()); return; }
    setError(r.error ?? null);
  }

  async function signOut() {
    await post("/api/auth/signout", {});
    router.replace("/signin");
  }

  return (
    <AuthShell approved>
      <h1>Set your own password</h1>
      <p className={styles.lead}>You signed in with a password we emailed you. Choose your own to continue. The emailed one stops working when you save.</p>
      <form onSubmit={submit} className={styles.card} style={{ border: 0, padding: 0 }} noValidate>
        {error && <div role="alert" className={styles.alert}>{error}</div>}
        <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
        <div className={styles.field}>
          <label htmlFor="current" className={styles.label}>Emailed password</label>
          <input id="current" name="current" type="password" autoComplete="current-password" required className={styles.input} />
        </div>
        <div className={styles.field}>
          <label htmlFor="password" className={styles.label}>New password</label>
          <input id="password" name="password" type="password" autoComplete="new-password" placeholder="At least 8 characters" required className={styles.input} />
          <span className={styles.hint}>At least 8 characters, with a letter and a number.</span>
        </div>
        <div className={styles.field}>
          <label htmlFor="confirm" className={styles.label}>Confirm new password</label>
          <input id="confirm" name="confirm" type="password" autoComplete="new-password" placeholder="Type it again" required className={styles.input} />
        </div>
        <button type="submit" disabled={busy} className={styles.primary}>{busy ? "Saving…" : "Save and continue"}</button>
        <button type="button" onClick={signOut} className={styles.secondary}>Sign out</button>
      </form>
    </AuthShell>
  );
}
