import Link from "next/link";

export const metadata = { title: "You are offline · Sheet Happens Officer" };

// SHO-US-22.10: shown when the phone has no connection. Nothing from the account is stored for offline use.
export default function Offline() {
  return (
    <main style={{ maxWidth: 420, margin: "20vh auto 0", padding: "0 16px", textAlign: "center" }}>
      <img src="/logo-icon.svg" alt="" width={72} height={72} />
      <h1 style={{ fontSize: 22, margin: "16px 0 8px" }}>You are offline</h1>
      <p style={{ color: "#555", lineHeight: 1.5 }}>Sheet Happens Officer needs a connection to show your tasks. Nothing was lost. Check your signal, then try again.</p>
      <Link href="/" style={{ display: "inline-block", marginTop: 16, padding: "12px 20px", background: "#2c2f71", color: "#fff", borderRadius: 8, textDecoration: "none", minHeight: 44 }}>Try again</Link>
    </main>
  );
}
