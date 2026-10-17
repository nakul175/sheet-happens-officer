import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { SignOutButton } from "./SignOutButton";
import styles from "@/components/auth.module.css";

// Placeholder landing page until My tasks (a later slice) replaces it.
export async function AppHome() {
  let user;
  try {
    user = await currentUser();
  } catch {
    redirect("/signin");
  }
  return (
    <main className={styles.wrap}>
      <div className={styles.col}>
        <section className={styles.card}>
          <h1>Hello, {user.name}</h1>
          <p className={styles.lead}>You are signed in as {user.email}. My tasks arrives in the next slice.</p>
          <SignOutButton />
        </section>
      </div>
    </main>
  );
}
