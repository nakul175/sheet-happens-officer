import styles from "./auth.module.css";

export function AuthShell({ children }: { children: React.ReactNode }) {
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
