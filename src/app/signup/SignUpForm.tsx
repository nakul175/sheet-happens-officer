"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AuthShell } from "@/components/AuthShell";
import styles from "@/components/auth.module.css";
import { post, rememberEmail } from "@/components/client";

export function SignUpForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email")).trim().toLowerCase();
    setBusy(true);
    setError(null);
    setExists(false);
    const r = await post("/api/auth/signup", { name: f.get("name"), email, password: f.get("password") });
    setBusy(false);
    if (r.ok) {
      rememberEmail(email);
      router.push("/check-email");
      return;
    }
    setExists(r.status === 409);
    setError(r.error ?? null);
  }

  return (
    <AuthShell>
      <h1>Create your account</h1>
      <form onSubmit={submit} className={styles.card} style={{ border: 0, padding: 0 }} noValidate>
        {error && (
          <div role="alert" className={styles.alert}>
            <span>{error}</span>
            {exists && <Link href="/signin">Sign in</Link>}
          </div>
        )}
        <div className={styles.field}>
          <label htmlFor="name" className={styles.label}>Full name</label>
          <input id="name" name="name" autoComplete="name" placeholder="Asha Rao" required className={styles.input} />
        </div>
        <div className={styles.field}>
          <label htmlFor="email" className={styles.label}>Work email</label>
          <input id="email" name="email" type="email" autoComplete="email" placeholder="you@aplyd.com" required className={styles.input} />
        </div>
        <div className={styles.field}>
          <label htmlFor="password" className={styles.label}>Password</label>
          <input id="password" name="password" type="password" autoComplete="new-password" placeholder="At least 8 characters" required className={styles.input} />
          <div className={styles.hint}>Use at least 8 characters, with at least one letter and one number.</div>
        </div>
        <button type="submit" disabled={busy} className={styles.primary}>{busy ? "Creating…" : "Create account"}</button>
      </form>
      <div className={styles.foot}>Already have an account? <Link href="/signin">Sign in</Link></div>
    </AuthShell>
  );
}
