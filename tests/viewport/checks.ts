// SHO-US-22.11: the in-page checks. Each function runs inside the browser, so it must not use anything from outside itself.
export type Finding = { check: "overflow" | "target" | "field" | "meta"; element: string; detail: string };

/** Runs every check on the page as it is now and returns what is wrong. `phone` is true under 600 px. */
export function collect(viewport: boolean | { phone: boolean; width: number }): Finding[] {
  const phone = typeof viewport === "boolean" ? viewport : viewport.phone;
  const out: Finding[] = [];
  const name = (e: Element) => {
    const id = e.id ? `#${e.id}` : "";
    const cls = typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
    const text = (e.getAttribute("aria-label") || e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28);
    return `${e.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ""}`;
  };
  const visible = (e: Element) => {
    const cs = getComputedStyle(e);
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // A box that scrolls on its own (a wide table in its own scroller) may be wider than the screen.
  const clipped = (e: Element) => {
    for (let p = e.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") return true;
    }
    return false;
  };

  // 1. No sideways scroll.
  // Mobile layout viewports can expand to fit an overflowing fixed-width element.
  // Compare with the runner's configured viewport, not that expanded innerWidth.
  const vw = typeof viewport === "boolean" ? window.innerWidth : viewport.width;
  const de = document.documentElement;
  if (de.scrollWidth > vw + 1 || document.body.scrollWidth > vw + 1) {
    const wide: { e: Element; right: number }[] = [];
    for (const e of document.body.querySelectorAll("*")) {
      if (!visible(e) || clipped(e) || getComputedStyle(e).position === "fixed") continue;
      const r = e.getBoundingClientRect();
      if (r.right > vw + 1) wide.push({ e, right: Math.round(r.right) });
    }
    wide.sort((a, b) => b.right - a.right);
    // Report the outermost wide elements: the first few are the cause, their children are only the effect.
    const seen: Element[] = [];
    for (const w of wide) {
      if (seen.some((s) => s.contains(w.e))) continue;
      seen.push(w.e);
      out.push({ check: "overflow", element: name(w.e), detail: `right edge at ${w.right} px, screen is ${vw} px` });
      if (seen.length >= 3) break;
    }
    if (!wide.length) out.push({ check: "overflow", element: "html", detail: `page is ${de.scrollWidth} px wide, screen is ${vw} px` });
  }

  if (phone) {
    // 2. Tap targets at least 44 by 44 px.
    const sel = 'button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=tab],[role=link],[tabindex="0"]';
    for (const e of document.querySelectorAll<HTMLElement>(sel)) {
      if (!visible(e)) continue;
      const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      let w = r.width, h = r.height;
      const af = getComputedStyle(e, "::after"); // an invisible ::after hit area counts
      if (af.content !== "none" && af.position === "absolute") {
        const i = [af.top, af.right, af.bottom, af.left].map(parseFloat);
        if (i.every((x) => !isNaN(x))) { w = r.width - i[1] - i[3]; h = r.height - i[0] - i[2]; }
      }
      const input = e as HTMLInputElement;
      if (input.type === "checkbox" || input.type === "radio") {
        const l = e.closest("label");
        if (l) { const lr = l.getBoundingClientRect(); w = Math.max(w, lr.width); h = Math.max(h, lr.height); }
      }
      if (e.tagName === "A" && cs.display === "inline" && e.closest("p,small,.hint,.sub,.t")) continue; // a link inside a sentence
      if (w < 43.5 || h < 43.5) out.push({ check: "target", element: name(e), detail: `${Math.round(w)} x ${Math.round(h)} px, needs 44 x 44` });
    }
    // 3. Fields at least 16 px, so iOS does not zoom in on focus.
    for (const e of document.querySelectorAll<HTMLInputElement>("input,select,textarea")) {
      if (!visible(e) || ["hidden", "checkbox", "radio", "file", "range", "button", "submit", "color"].includes(e.type)) continue;
      const fs = parseFloat(getComputedStyle(e).fontSize);
      if (fs < 15.99) out.push({ check: "field", element: name(e), detail: `font ${fs} px, needs 16` });
    }
  }

  // 4. viewport-fit=cover (the page may be drawn under the notch, so the app pads for it).
  const meta = document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "";
  if (!/viewport-fit\s*=\s*cover/.test(meta)) out.push({ check: "meta", element: "meta[name=viewport]", detail: `content is "${meta}", needs viewport-fit=cover` });
  return out;
}
