import styles from "./auth.module.css";
import approvedStyles from "@/app/signin/signin.module.css";
import { Hero } from "@/app/signin/Hero";

export function AuthShell({ children, approved = false }: { children: React.ReactNode; approved?: boolean }) {
  if (approved) return <main className={approvedStyles.wrap}>
    <div className={approvedStyles.brandtop}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-icon-reversed.svg" alt="" /><span>Sheet Happens Officer</span>
    </div>
    <Hero /><div className={approvedStyles.formside}><div className={`${styles.col} ${approvedStyles.col}`}><section className={`${styles.card} ${approvedStyles.signcard}`}>{children}</section></div></div>
  </main>;
  return (
    <main className={styles.wrap}>
      <div className={styles.col}>
        <div className={styles.brand}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-mark.svg" alt="" />
          <span>Sheet Happens Officer</span>
        </div>
        <section className={styles.card}>{children}</section>
      </div>
    </main>
  );
}
