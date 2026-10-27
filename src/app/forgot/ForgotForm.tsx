"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AuthShell } from "@/components/AuthShell";
import styles from "@/components/auth.module.css";
import { post, rememberEmail } from "@/components/client";

export function ForgotForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email")).trim().toLowerCase();
    setBusy(true);
    setError(null);
    const r = await post("/api/auth/forgot-password", { email });
    setBusy(false);
    if (r.ok) {
      rememberEmail(email);
      router.push("/check-reset");
    } else setError(r.error ?? null);
  }

  return (
    <AuthShell approved>
      <h1>Forgot password</h1>
      <p className={styles.lead}>Enter your work email and we will send you a link to set a new password.</p>
      <form onSubmit={submit} className={styles.card} style={{ border: 0, padding: 0 }} noValidate>
        {error && <div role="alert" className={styles.alert}>{error}</div>}
        <div className={styles.field}>
          <label htmlFor="email" className={styles.label}>Work email</label>
          <input id="email" name="email" type="email" autoComplete="username" placeholder="you@aplyd.com" required className={styles.input} />
        </div>
        <button type="submit" disabled={busy} className={styles.primary}>{busy ? "Sending…" : "Send reset link"}</button>
      </form>
      <div className={styles.center}><Link href="/signin">Back to sign in</Link></div>
    </AuthShell>
  );
}
