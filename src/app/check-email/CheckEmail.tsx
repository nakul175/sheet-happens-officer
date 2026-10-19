"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { AuthShell } from "@/components/AuthShell";
import styles from "@/components/auth.module.css";
import { post, recalledEmail } from "@/components/client";

/** APL-2742: sendFailed is set when sign-up created the account but the verification email did not go (same text as VERIFY_SEND_FAILED in lib/email). */
export function CheckEmail({ sendFailed = false }: { sendFailed?: boolean }) {
  const email = useSyncExternalStore(() => () => {}, recalledEmail, () => "");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(
    sendFailed ? "We created your account but could not send the verification email. Use Resend below in a few minutes; if it still does not arrive, contact your Super Admin." : null,
  );

  async function resend() {
    if (!email) return;
    const r = await post("/api/auth/resend-verification", { email });
    setSent(r.ok);
    setError(r.ok ? null : (r.error ?? null));
  }

  return (
    <AuthShell>
      <h1>Check your email</h1>
      {!sendFailed && (
        <p className={styles.lead}>
          We sent a verification link{email ? <> to <strong>{email}</strong></> : null}. Click it to activate your account. The link works for 24 hours.
        </p>
      )}
      {error && <div className={styles.alert} role="alert"><span>{error}</span></div>}
      {sent && <div className={styles.notice} role="status">If this address needs a new link, it has been sent. You can ask up to 3 times an hour; if you have asked that often already, try again later.</div>}
      <div className={styles.foot} style={{ textAlign: "left" }}>
        Did not get it? Check spam, or{" "}
        {email ? <button type="button" onClick={resend} className={styles.linkbtn}>resend the link</button> : <Link href="/signup">sign up again</Link>}.
      </div>
      <div className={styles.center}><Link href="/signin">Back to sign in</Link></div>
    </AuthShell>
  );
}
