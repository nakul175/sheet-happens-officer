"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "@/components/auth.module.css";
import { post, rememberEmail } from "@/components/client";
import { returnToEnabled, safeReturnPath } from "@/lib/return-to";
import s from "./signin.module.css";

export function SignInForm({ justReset, centralEnabled = false, sessionExpired = false, next }: { justReset: boolean; centralEnabled?: boolean; sessionExpired?: boolean; next?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [needsVerify, setNeedsVerify] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email")).trim().toLowerCase();
    setBusy(true);
    setError(null);
    setNeedsVerify(null);
    const r = await post("/api/auth/signin", { email, password: f.get("password") });
    setBusy(false);
    if (r.ok) {
      const bridgeReturn = new URLSearchParams(window.location.search).get("returnTo");
      router.push(bridgeReturn?.startsWith("/api/suite/authorize?")
        ? bridgeReturn
        : returnToEnabled() ? (safeReturnPath(next, 1) ?? "/") : "/");
      router.refresh();
      return;
    }
    setError(r.error ?? null);
    if (r.status === 403 && r.data?.code === "EMAIL_NOT_VERIFIED") setNeedsVerify(email);
  }

  async function resend(email: string) {
    const r = await post("/api/auth/resend-verification", { email });
    if (!r.ok) {
      setError(r.error ?? null); // APL-2742: a refused send is shown here, with the Resend button still offered
      return;
    }
    rememberEmail(email);
    router.push("/check-email?resent=1"); // APL-2742: the next screen must not say the email went
  }

  return (
    <div className={`${styles.col} ${s.col}`}>
      <section className={`${styles.card} ${s.signcard}`}>
      <h1 className={s.h2}>Sign in</h1>
      {centralEnabled && <><a className={s.sso} href={returnToEnabled() && safeReturnPath(next, 1) ? `/api/auth/aplyd/start?next=${encodeURIComponent(safeReturnPath(next, 1)!)}` : "/api/auth/aplyd/start"}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/aplyd-symbol.svg" alt="" aria-hidden="true" /><span>Continue with Aplyd</span>
      </a><div className={s.divider}>or use your email</div></>}
      <form onSubmit={submit} className={styles.card} style={{ border: 0, padding: 0 }} noValidate>
        {sessionExpired && !error && <div role="alert" className={styles.alert}>Your session has expired, please sign in again</div>}
        {justReset && !error && <div role="status" className={styles.notice}>Password changed. Sign in with your new password.</div>}
        {error && (
          <div role="alert" className={styles.alert}>
            <span>{error}</span>
            {needsVerify && (
              <button type="button" className={styles.linkbtn} style={{ color: "inherit" }} onClick={() => resend(needsVerify)}>
                Resend link
              </button>
            )}
          </div>
        )}
        <div className={styles.field}>
          <label htmlFor="email" className={styles.label}>Work email</label>
          <input id="email" name="email" type="email" autoComplete="username" placeholder="you@aplyd.com" required className={styles.input} />
        </div>
        <div className={styles.field}>
          <div className={styles.row}>
            <label htmlFor="password" className={styles.label}>Password</label>
            <Link href="/forgot" className={styles.small}>Forgot password?</Link>
          </div>
          <input id="password" name="password" type="password" autoComplete="current-password" placeholder="Your password" required className={styles.input} />
        </div>
        <button type="submit" disabled={busy} className={styles.primary}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
      </section>
      <div className={styles.foot}>Not signed up yet? <Link href="/signup">Sign up</Link></div>
    </div>
  );
}
