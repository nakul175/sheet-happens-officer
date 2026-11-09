"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import styles from "@/components/auth.module.css";
import { post, recalledEmail } from "@/components/client";

// Sends a fresh verification link to the address typed earlier in this tab, or asks for it on Sign in.
export function ResendLink() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  async function go() {
    if (sending.current) return;
    const email = recalledEmail();
    if (!email) return router.push("/signin");
    sending.current = true;
    setBusy(true);
    setError("");
    const result = await post("/api/auth/resend-verification", { email });
    if (!result.ok) {
      sending.current = false;
      setBusy(false);
      setError("Could not request a new link right now. Check your connection and try again.");
      return;
    }
    router.push("/check-email?resent=1"); // APL-2742: neutral screen, never "we sent"
  }
  return (
    <>
      {error && <p role="alert" className={styles.alert}>{error}</p>}
      <button type="button" onClick={go} disabled={busy} className={styles.primary}>
        {busy ? "Requesting…" : "Send a new verification link"}
      </button>
    </>
  );
}
