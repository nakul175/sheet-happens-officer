"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ago, api, initials, useGet } from "@/components/api";
import { ConciergeProvider, useConcierge } from "@/components/concierge/ConciergeProvider";
import { ConciergeBar, ConciergeDock, ConciergeFab } from "@/components/concierge/Concierge";
import { Bell } from "./Bell";
import { ConciergeHost, ConciergeNavItem, openConcierge } from "@/components/concierge/Launcher";
import { Extras, NewTaskButton, SearchButton } from "@/components/extras/Extras";

export type Me = { id: string; name: string; email: string; orgRole: "MEMBER" | "ADMIN" | "SUPER_ADMIN"; crm?: boolean; review?: boolean; compact?: boolean; startGuide?: boolean; tempPassword?: boolean };
const MeCtx = createContext<Me | null>(null);
export const useMe = () => useContext(MeCtx)!;
/** A deal page lives at /projects/[id]; it tells the sidebar to highlight Deals instead of Projects. */
const NavHintCtx = createContext<(h: string | null) => void>(() => {});
export function useNavHint(hint: string | null) {
  const set = useContext(NavHintCtx);
  useEffect(() => { set(hint); return () => set(null); }, [hint, set]);
}
export const roleLabel = (r: Me["orgRole"]) => (r === "SUPER_ADMIN" ? "Super Admin" : r === "ADMIN" ? "Admin" : "Member");

/** SHO-US-22.4: bottom tab bar under 600 px. The server still decides who may open Usage and Audit; this only decides what is listed. */
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
          <button role="menuitem" onClick={() => { setOpen(false); openConcierge(); }}>Concierge</button>
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

/** SHO-US-14.12: Comfortable or Compact rows. Saved on the person; shown from 1024 px wide (phones keep full-size rows for touch). */
function DensityToggle({ compact, onChange }: { compact: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className="density" aria-pressed={compact} title="Show more rows on one screen" onClick={() => onChange(!compact)}>
      <span aria-hidden>{compact ? "☰" : "≡"}</span> Compact
    </button>
  );
}

export function Shell({ user, children }: { user: Me; children: React.ReactNode }) {
  const path = usePathname();
  const [compact, setCompact] = useState(!!user.compact);
  const chooseDensity = async (v: boolean) => {
    setCompact(v);
    const r = await api("PUT", "/api/profile/density", { compact: v });
    if (!r.ok) setCompact(!v); // not saved: go back to what is saved
  };
  const [menu, setMenu] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const open = menu === path;
  const here = (p: string) => {
    if (hint && path.startsWith("/projects/")) return p === hint;
    return p === "/" ? path === "/" : path === p || path.startsWith(p + "/");
  };
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
      <NavHintCtx.Provider value={setHint}>
      <ConciergeProvider>
      <Extras>
      <div className="shell" data-density={compact ? "compact" : undefined}>
        <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); const m = document.getElementById("main"); m?.focus(); m?.scrollIntoView(); }}>Skip to content</a>
        {open && <div className="veil" onClick={() => setMenu(null)} />}
        <aside ref={drawer} className={`side${open ? " open" : ""}`} aria-label="Main">
          <Link href="/" className="brand"><img src="/logo-icon.svg" alt="" />Sheet Happens Officer</Link>
          <nav className="nav">
            {items.map(([href, label]) => (
              <Link key={href} href={href} aria-current={here(href) ? "page" : undefined}>{label}</Link>
            ))}
            <ConciergeNavItem onPick={() => setMenu(null)} />
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
            <SearchButton />
            <NewTaskButton />
            <DensityToggle compact={compact} onChange={chooseDensity} />
            <Bell />
          </header>
          {user.tempPassword && <SetPasswordBar />}
          {children}
        </div>
        <TabBar user={user} here={here} more={more} />
        <ConciergeHost />
      </div>
      </Extras>
      </ConciergeProvider>
      </NavHintCtx.Provider>
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
      <main id="main" tabIndex={-1} className={`content${dock && !hidden ? " with-dock" : ""}${bar && !hidden ? " with-bar" : ""}`}>
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
