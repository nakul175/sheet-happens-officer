import styles from "./auth.module.css";

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className={styles.wrap}>
      <div className={styles.col}>
        <div className={styles.brand}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/little-bot-heroes/sho-head.png" className="aplyd-bot" alt="" width={48} height={48} />
          <span>Sheet Happens Officer</span>
        </div>
        <section className={styles.card}>{children}</section>
      </div>
    </main>
  );
}
