"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "@/components/auth.module.css";
import { post, rememberEmail } from "@/components/client";
import { safeReturnPath } from "@/lib/return-to";
import s from "./signin.module.css";

export function SignInForm({ justReset, sessionExpired = false, next }: { justReset: boolean; sessionExpired?: boolean; next?: string }) {
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
      // A failed attempt never reaches here, so `next` stays in the address bar (APL-2652 AC4).
      // Checked again: the prop is only a path, and router.push is never given an absolute URL.
      router.push(safeReturnPath(next) ?? "/");
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
    <div className={styles.col}>
      <div className={`${styles.brand} ${s.brand}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-mark.svg" alt="" />
        <span>Sheet Happens Officer</span>
      </div>
      <section className={styles.card}>
      <h2 className={s.h2}>Sign in</h2>
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
