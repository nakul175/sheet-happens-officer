import Link from "next/link";
import s from "./offline.module.css";

export const metadata = { title: "You are offline · Sheet Happens Officer" };

// SHO-US-22.10: shown when the phone has no connection. Nothing from the account is stored for offline use.
export default function Offline() {
  return (
    <main className={s.page}><section className={s.card}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-icon.svg" alt="" width={72} height={72} />
      <h1>You are offline</h1>
      <span className={s.gold} aria-hidden="true" /><p>Sheet Happens Officer needs a connection to show your tasks. Nothing was lost. Check your signal, then try again.</p>
      <Link href="/" className={s.retry}>Try again</Link>
    </section></main>
  );
}
