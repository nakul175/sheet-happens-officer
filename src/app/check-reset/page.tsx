import Link from "next/link";
import { AuthShell } from "@/components/AuthShell";
import styles from "@/components/auth.module.css";
export const metadata = { title: "Check your email · Sheet Happens Officer" };
export default function Page() {
  return (
    <AuthShell>
      <h1>Check your email</h1>
      <p className={styles.lead}>If an account exists for that address, we sent a link to reset your password. The link works for 1 hour.</p>
      <div className={styles.foot} style={{ textAlign: "left" }}>Nothing yet? Check spam, or <Link href="/forgot">try again</Link>.</div>
      <div className={styles.center}><Link href="/signin">Back to sign in</Link></div>
    </AuthShell>
  );
}
