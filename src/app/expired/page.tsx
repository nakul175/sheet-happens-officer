import Link from "next/link";
import { AuthShell } from "@/components/AuthShell";
import styles from "@/components/auth.module.css";
import { ResendLink } from "./ResendLink";
export const metadata = { title: "Link can't be used · Sheet Happens Officer" };
export default function Page() {
  return (
    <AuthShell>
      {/* APL-2742: shared by verify and reset links. A used link usually means it already worked, so sign-in comes first. */}
      <h1>This link can&apos;t be used</h1>
      <p className={styles.lead}>It may have expired, been used already or been replaced by a newer link. If you already used it, sign in. Otherwise, ask for a new link below.</p>
      <ResendLink />
      <Link href="/forgot" className={styles.secondary}>Request a new reset link</Link>
      <div className={styles.center}><Link href="/signin">Back to sign in</Link></div>
    </AuthShell>
  );
}
