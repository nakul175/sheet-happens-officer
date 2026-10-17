import Link from "next/link";
import { AuthShell } from "@/components/AuthShell";
import styles from "@/components/auth.module.css";
import { ResendLink } from "./ResendLink";
export const metadata = { title: "Link expired · Sheet Happens Officer" };
export default function Page() {
  return (
    <AuthShell>
      <h1>This link has expired</h1>
      <p className={styles.lead}>Links work once and expire after a set time. Ask for a new one.</p>
      <ResendLink />
      <Link href="/forgot" className={styles.secondary}>Request a new reset link</Link>
      <div className={styles.center}><Link href="/signin">Back to sign in</Link></div>
    </AuthShell>
  );
}
