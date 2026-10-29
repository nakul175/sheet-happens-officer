import Link from "next/link";
import { AuthShell } from "@/components/AuthShell";
import styles from "@/components/auth.module.css";
import approvedStyles from "@/app/signin/signin.module.css";
export const metadata = { title: "Check your email · Sheet Happens Officer" };
export default function Page() {
  return (
    <AuthShell approved>
      <svg className={approvedStyles.stateIcon} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="6" width="26" height="20" rx="2"/><path d="m4 7 12 10L28 7"/></svg>
      <h1>Check your email</h1>
      <p className={styles.lead}>If an account exists for that address, we sent a link to reset your password. The link works for 1 hour.</p>
      <div className={styles.foot} style={{ textAlign: "left" }}>Nothing yet? Check spam, or <Link href="/forgot">try again</Link>.</div>
      <div className={styles.center}><Link href="/signin">Back to sign in</Link></div>
    </AuthShell>
  );
}
