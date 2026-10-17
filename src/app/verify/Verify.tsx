"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AuthShell } from "@/components/AuthShell";
import styles from "@/components/auth.module.css";
import { post } from "@/components/client";

export function Verify() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [done, setDone] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // a link works once; never submit it twice
    started.current = true;
    if (!token) return router.replace("/expired");
    post("/api/auth/verify", { token }).then((r) => (r.ok ? setDone(true) : router.replace("/expired")));
  }, [token, router]);

  return (
    <AuthShell>
      {done ? (
        <>
          <h1>Email verified</h1>
          <p className={styles.lead}>Your account is ready. Sign in to start.</p>
          <Link href="/signin" className={styles.primary}>Sign in</Link>
        </>
      ) : (
        <>
          <h1>Verifying…</h1>
          <p className={styles.lead}>One moment.</p>
        </>
      )}
    </AuthShell>
  );
}
