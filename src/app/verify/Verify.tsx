"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AuthShell } from "@/components/AuthShell";
import styles from "@/components/auth.module.css";
import approvedStyles from "@/app/signin/signin.module.css";
import { post } from "@/components/client";

// APL-2742: opening the link only shows a button. Mail link scanners open links without a person, so the token is
// posted on the click alone, never on load.
export function Verify() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (!token) router.replace("/expired");
  }, [token, router]);

  async function verify() {
    if (started.current) return; // a link works once; never submit it twice
    started.current = true;
    setBusy(true);
    const r = await post("/api/auth/verify", { token });
    if (r.ok) setDone(true);
    else router.replace("/expired");
  }

  return (
    <AuthShell approved>
      <svg className={approvedStyles.stateIcon} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="16" cy="16" r="13"/><path d="m10 16 4 4 8-9"/></svg>
      {done ? (
        <>
          <h1>Email verified</h1>
          <p className={styles.lead}>Your account is ready. Sign in to start.</p>
          <Link href="/signin" className={styles.primary}>Sign in</Link>
        </>
      ) : (
        <>
          <h1>Verify your email</h1>
          <p className={styles.lead}>Confirm this is your address to finish creating your account.</p>
          <button type="button" onClick={verify} disabled={busy || !token} className={styles.primary}>
            {busy ? "Verifying…" : "Verify my email"}
          </button>
          <Link href="/signin" className={styles.center}>Back to sign in</Link>
        </>
      )}
    </AuthShell>
  );
}
