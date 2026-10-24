"use client";

import { useRouter } from "next/navigation";
import styles from "@/components/auth.module.css";
import { post, recalledEmail } from "@/components/client";

// Sends a fresh verification link to the address typed earlier in this tab, or asks for it on Sign in.
export function ResendLink() {
  const router = useRouter();
  async function go() {
    const email = recalledEmail();
    if (!email) return router.push("/signin");
    await post("/api/auth/resend-verification", { email });
    router.push("/check-email?resent=1"); // APL-2742: neutral screen, never "we sent"
  }
  return (
    <button type="button" onClick={go} className={styles.primary}>
      Send a new verification link
    </button>
  );
}
