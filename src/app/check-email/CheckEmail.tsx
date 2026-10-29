"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { AuthShell } from "@/components/AuthShell";
import styles from "@/components/auth.module.css";
import approvedStyles from "@/app/signin/signin.module.css";
import { post, recalledEmail } from "@/components/client";
import { RESEND_NOTICE, VERIFY_SEND_FAILED } from "@/lib/auth-messages";

/**
 * APL-2742. sendFailed: sign-up created the account but its email did not go. resent: the person came here from a resend
 * (sign-in refusal or /expired), whose outcome is never told, so the "We sent" line is replaced by the neutral notice.
 */
export function CheckEmail({ sendFailed = false, resent = false }: { sendFailed?: boolean; resent?: boolean }) {
  const email = useSyncExternalStore(() => () => {}, recalledEmail, () => "");
  const [sent, setSent] = useState(resent);
  const [error, setError] = useState<string | null>(sendFailed ? VERIFY_SEND_FAILED : null);

  async function resend() {
    if (!email) return;
    const r = await post("/api/auth/resend-verification", { email });
    setSent(r.ok);
    setError(r.ok ? null : (r.error ?? null));
  }

  return (
    <AuthShell approved>
      <svg className={approvedStyles.stateIcon} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="6" width="26" height="20" rx="2"/><path d="m4 7 12 10L28 7"/></svg>
      <h1>Check your email</h1>
      {!sendFailed && !resent && (
        <p className={styles.lead}>
          We sent a verification link{email ? <> to <strong>{email}</strong></> : null}. Click it to activate your account. The link works for 24 hours.
        </p>
      )}
      {error && <div className={styles.alert} role="alert"><span>{error}</span></div>}
      {sent && <div className={styles.notice} role="status">{RESEND_NOTICE}</div>}
      <div className={styles.foot} style={{ textAlign: "left" }}>
        Did not get it? Check spam, or{" "}
        {email ? <button type="button" onClick={resend} className={styles.linkbtn}>resend the link</button> : <Link href="/signup">sign up again</Link>}.
      </div>
      <div className={styles.center}><Link href="/signin">Back to sign in</Link></div>
    </AuthShell>
  );
}
