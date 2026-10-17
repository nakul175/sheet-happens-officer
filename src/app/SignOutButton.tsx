"use client";

import { useRouter } from "next/navigation";
import styles from "@/components/auth.module.css";
import { post } from "@/components/client";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className={styles.secondary}
      onClick={async () => {
        await post("/api/auth/signout");
        router.push("/signin");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
