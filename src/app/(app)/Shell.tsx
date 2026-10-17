"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ago, api, initials, useGet } from "@/components/api";
import { ConciergeProvider, useConcierge } from "@/components/concierge/ConciergeProvider";
import { ConciergeBar, ConciergeDock, ConciergeFab } from "@/components/concierge/Concierge";

export type Me = { id: string; name: string; email: string; orgRole: "MEMBER" | "ADMIN" | "SUPER_ADMIN"; crm?: boolean; review?: boolean; tempPassword?: boolean };
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


/** SHO-US-10.4: bottom tab bar under 600 px. The server still decides who may open Usage and Audit; this only decides what is listed. */
function TabBar({ user, here, more }: { user: Me; here: (p: string) => boolean; more: [string, string][] }) {
  const path = usePathname();
  const [openAt, setOpenAt] = useState<string | null>(null); // the menu belongs to the page it was opened on
  const open = openAt === path;
  const setOpen = (v: boolean | ((x: boolean) => boolean)) => setOpenAt((cur) => ((typeof v === "function" ? v(cur === path) : v) ? path : null));
  const [typing, setTyping] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The keyboard hides the bar (a field has focus), so it never sits on top of what is being typed.
    const on = (e: FocusEvent) => setTyping(!!(e.target as HTMLElement | null)?.matches?.("input:not([type=checkbox]):not([type=radio]), textarea, select"));
    const off = () => setTyping(false);
    document.addEventListener("focusin", on);
    document.addEventListener("focusout", off);
    return () => { document.removeEventListener("focusin", on); document.removeEventListener("focusout", off); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("keydown", esc);
    document.addEventListener("pointerdown", away);
    return () => { document.removeEventListener("keydown", esc); document.removeEventListener("pointerdown", away); };
  }, [open]);
  const tabs: [string, string, string][] = [["/", "My tasks", "✓"], ["/projects", "Projects", "▤"], ["/search", "Search", "⌕"]];
  const moreHere = more.some(([h]) => here(h)) || here("/profile");
  return (
    <div className={`tabbar-wrap${typing ? " typing" : ""}`} ref={box}>
      {open && (
        <div className="tabmore" role="menu" aria-label="More">
          {more.map(([h, l]) => <Link key={h} href={h} role="menuitem">{l}</Link>)}
          <Link href="/profile" role="menuitem">Profile</Link>
          <button role="menuitem" onClick={async () => { await api("POST", "/api/auth/signout", {}); window.location.href = "/signin"; }}>Sign out</button>
        </div>
      )}
      <nav className="tabbar" aria-label="Main">
        {tabs.map(([h, l, i]) => (
          <Link key={h} href={h} aria-current={here(h) ? "page" : undefined}><span aria-hidden>{i}</span>{l}</Link>
        ))}
        <button aria-expanded={open} aria-haspopup="menu" aria-current={moreHere ? "true" : undefined} onClick={() => setOpen((v) => !v)}><span aria-hidden>⋯</span>More</button>
      </nav>
    </div>
  );
}

/** SHO-US-15.3. A nudge, not a wall: the person was given a password and may keep it. */
let barClosed = false; // fallback when sessionStorage is blocked
const barListen = (cb: () => void) => { window.addEventListener("sho-pwbar", cb); return () => window.removeEventListener("sho-pwbar", cb); };
const barIsClosed = () => { try { return barClosed || sessionStorage.getItem("sho_pwbar") === "1"; } catch { return barClosed; } };
function SetPasswordBar() {
  // The server snapshot is "closed", so the server and the first browser render match; the real answer follows.
  const closed = useSyncExternalStore(barListen, barIsClosed, () => true);
  if (closed) return null;
  return (
    <div className="pwbar" role="status">
      <span>Set your own password. The emailed one still works until you do.</span>
      <Link href="/profile">Change password</Link>
      <button className="btn ghost sm" aria-label="Close this message" onClick={() => { barClosed = true; try { sessionStorage.setItem("sho_pwbar", "1"); } catch { /* ignore */ } window.dispatchEvent(new Event("sho-pwbar")); }}>×</button>
    </div>
  );
}

export function Shell({ user, children }: { user: Me; children: React.ReactNode }) {
  const path = usePathname();
  const [menu, setMenu] = useState<string | null>(null);
  const open = menu === path;
  const here = (p: string) => (p === "/" ? path === "/" : path === p || path.startsWith(p + "/"));
  const items: [string, string][] = [["/", "My tasks"], ["/projects", "Projects"], ...(user.crm ? [["/deals", "Deals"], ["/accounts", "Accounts"], ...(user.review ? [["/review", "Pipeline review"]] : [])] as [string, string][] : []), ["/team", "Team"], ["/search", "Search"]];
  if (user.orgRole === "SUPER_ADMIN") items.push(["/usage", "Usage"], ["/audit", "Audit log"]);
  const more = items.filter(([h]) => !["/", "/projects", "/search"].includes(h));
  const drawer = useRef<HTMLElement>(null);
  useEffect(() => {
    // Drawer (600 to 1023 px): Escape closes it, Tab stays inside it, and focus returns to the burger.
    if (!open) return;
    const el = drawer.current;
    el?.querySelector<HTMLElement>("a")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setMenu(null); return; }
      if (e.key !== "Tab" || !el) return;
      const f = [...el.querySelectorAll<HTMLElement>("a[href], button")];
      if (!f.length) return;
      const a = document.activeElement;
      if (e.shiftKey && (a === f[0] || !el.contains(a))) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && (a === f[f.length - 1] || !el.contains(a))) { e.preventDefault(); f[0].focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); document.querySelector<HTMLElement>(".burger")?.focus(); };
  }, [open]);
  return (
    <MeCtx.Provider value={user}>
      <ConciergeProvider>
      <div className="shell">
        {open && <div className="veil" onClick={() => setMenu(null)} />}
        <aside ref={drawer} className={`side${open ? " open" : ""}`} aria-label="Main">
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
          {user.tempPassword && <SetPasswordBar />}
          {children}
        </div>
        <TabBar user={user} here={here} more={more} />
      </div>
      </ConciergeProvider>
    </MeCtx.Provider>
  );
}

/** Page frame. `dock` reserves the 340 px concierge column on wide screens (list screens only). */
export function Page({ title, docTitle, sub, actions, dock, bar, children }: { title?: React.ReactNode; docTitle?: string; sub?: React.ReactNode; actions?: React.ReactNode; dock?: boolean; bar?: boolean; children: React.ReactNode }) {
  const slot = dock || bar;
  const tab = docTitle ?? (typeof title === "string" ? title : undefined);
  useEffect(() => { if (tab) document.title = `${tab} · Sheet Happens Officer`; }, [tab]);
  const hidden = useConcierge()?.hidden ?? false; // a hidden concierge gives its space back
  return (
    <>
      <main className={`content${dock && !hidden ? " with-dock" : ""}${bar && !hidden ? " with-bar" : ""}`}>
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
      {dock && <ConciergeDock />}
      {bar && <ConciergeBar />}
      {slot && <ConciergeFab kind={dock ? "dock" : "bar"} />}
    </>
  );
}

export function SignOut() {
  return (
    <button className="btn ghost" onClick={async () => { await api("POST", "/api/auth/signout", {}); window.location.href = "/signin"; }}>Sign out</button>
  );
}
