"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ago, api, initials, useGet } from "@/components/api";

export type Me = { id: string; name: string; email: string; orgRole: "MEMBER" | "ADMIN" | "SUPER_ADMIN" };
const MeCtx = createContext<Me | null>(null);
export const useMe = () => useContext(MeCtx)!;
export const roleLabel = (r: Me["orgRole"]) => (r === "SUPER_ADMIN" ? "Super Admin" : r === "ADMIN" ? "Admin" : "Member");

type Note = { id: string; text: string; href: string; read: boolean; createdAt: string };

function Bell() {
  const { data, reload } = useGet<{ unread: number; items: Note[] }>("/api/notifications");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const [fresh, setFresh] = useState<Set<string>>(new Set()); // shown as new while the panel stays open
  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    // SHO-US-7.1 AC2: opening the panel marks what it shows as read; the new ones stay highlighted until it closes.
    const r = await api<{ unread: number; items: Note[] }>("GET", "/api/notifications");
    const ids = r.ok ? r.data.items.filter((n) => !n.read).map((n) => n.id) : [];
    setFresh(new Set(ids));
    if (ids.length) await api("POST", "/api/notifications/read-all", {});
    reload();
  }
  useEffect(() => {
    const t = setInterval(reload, 60_000);
    return () => clearInterval(t);
  }, [reload]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const unread = data?.unread ?? 0;
  return (
    <div className="wrapper" ref={box}>
      <button className="bell" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"} aria-expanded={open}
        onClick={toggle}>
        🔔{unread > 0 && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="panel" role="dialog" aria-label="Notifications">
          <header>
            <span>Notifications</span>
            {unread > 0 && <button className="link" onClick={async () => { await api("POST", "/api/notifications/read-all", {}); reload(); }}>Mark all as read</button>}
          </header>
          {!data?.items.length && <div className="empty">You are all caught up.</div>}
          {data?.items.map((n) => (
            <Link key={n.id} href={n.href} className={`row${!n.read || fresh.has(n.id) ? " unread" : ""}`}
              onClick={async (e) => {
                e.preventDefault();
                setOpen(false);
                if (!n.read) await api("POST", `/api/notifications/${n.id}/read`, {});
                reload();
                router.push(n.href);
              }}>
              {n.text}
              <small>{ago(n.createdAt)}</small>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function Shell({ user, children }: { user: Me; children: React.ReactNode }) {
  const path = usePathname();
  const [menu, setMenu] = useState<string | null>(null);
  const open = menu === path;
  const here = (p: string) => (p === "/" ? path === "/" : path === p || path.startsWith(p + "/"));
  const items: [string, string][] = [["/", "My tasks"], ["/projects", "Projects"], ["/team", "Team"]];
  if (user.orgRole === "SUPER_ADMIN") items.push(["/audit", "Audit log"]);
  return (
    <MeCtx.Provider value={user}>
      <div className="shell">
        {open && <div className="veil" onClick={() => setMenu(null)} />}
        <aside className={`side${open ? " open" : ""}`} aria-label="Main">
          <Link href="/" className="brand"><img src="/logo-icon.svg" alt="" />Sheet Happens Officer</Link>
          <nav className="nav">
            {items.map(([href, label]) => (
              <Link key={href} href={href} aria-current={here(href) ? "page" : undefined}>{label}</Link>
            ))}
          </nav>
          <Link href="/profile" className="me" aria-current={here("/profile") ? "page" : undefined}>
            <span className="av">{initials(user.name)}</span>
            <span><strong>{user.name}</strong><small>{roleLabel(user.orgRole)}</small></span>
          </Link>
        </aside>
        <div className="main">
          <header className="top">
            <button className="burger" aria-label="Open menu" onClick={() => setMenu(path)}>☰</button>
            <span className="top-brand"><img src="/logo-icon.svg" alt="" />SHO</span>
            <span className="grow" />
            <Bell />
          </header>
          {children}
        </div>
      </div>
    </MeCtx.Provider>
  );
}

/** Page frame. `dock` reserves the 340 px concierge column on wide screens (list screens only). */
export function Page({ title, sub, actions, dock, bar, children }: { title?: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode; dock?: boolean; bar?: boolean; children: React.ReactNode }) {
  const [sheet, setSheet] = useState(false);
  const slot = dock || bar;
  return (
    <>
      <main className={`content${dock ? " with-dock" : ""}${bar ? " with-bar" : ""}`}>
        {(title || actions) && (
          <div className="head">
            <div className="grow">
              {title && <h1 className="pt">{title}</h1>}
              {sub && <p className="sub">{sub}</p>}
            </div>
            {actions}
          </div>
        )}
        {children}
      </main>
      {dock && <aside className="dock" aria-label="Concierge"><strong>Concierge</strong>The assistant arrives in a later release. This column is kept free for it.</aside>}
      {bar && <aside className="bardock" aria-label="Concierge"><strong>Concierge</strong> The assistant arrives in a later release. This bar is kept free for it.</aside>}
      {slot && (
        <>
          <button className="fab" aria-label="Concierge" aria-expanded={sheet} onClick={() => setSheet(!sheet)}>💬</button>
          {sheet && <div className="fabsheet" role="dialog" aria-label="Concierge"><strong>Concierge</strong>The assistant arrives in a later release.<button className="link" onClick={() => setSheet(false)}>Close</button></div>}
        </>
      )}
    </>
  );
}

export function SignOut() {
  return (
    <button className="btn ghost" onClick={async () => { await api("POST", "/api/auth/signout", {}); window.location.href = "/signin"; }}>Sign out</button>
  );
}
