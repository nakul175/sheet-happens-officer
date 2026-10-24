"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { AuthShell } from "@/components/AuthShell";
import styles from "@/components/auth.module.css";
import { post } from "@/components/client";

export function ResetForm() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const r = await post("/api/auth/reset-password", { token, password: f.get("password"), confirm: f.get("confirm") });
    setBusy(false);
    if (r.ok) router.push("/signin?reset=1");
    else if (r.status === 400 && /expired/.test(r.error ?? "")) router.push("/expired");
    else setError(r.error ?? null);
  }

  return (
    <AuthShell>
      <h1>Set a new password</h1>
      <form onSubmit={submit} className={styles.card} style={{ border: 0, padding: 0 }} noValidate>
        {error && <div role="alert" className={styles.alert}>{error}</div>}
        <div className={styles.field}>
          <label htmlFor="password" className={styles.label}>New password</label>
          <input id="password" name="password" type="password" autoComplete="new-password" placeholder="At least 8 characters" required className={styles.input} />
        </div>
        <div className={styles.field}>
          <label htmlFor="confirm" className={styles.label}>Confirm new password</label>
          <input id="confirm" name="confirm" type="password" autoComplete="new-password" placeholder="Type it again" required className={styles.input} />
        </div>
        <button type="submit" disabled={busy} className={styles.primary}>{busy ? "Saving…" : "Save and sign in"}</button>
        <div className={styles.hint} style={{ textAlign: "center" }}>Saving signs you out on all other devices.</div>
      </form>
    </AuthShell>
  );
}
