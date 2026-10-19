import type { Locator } from "@playwright/test";

/**
 * Click or check a control on a phone-width page.
 *
 * Two layouts make Playwright's default point miss, and the click then retries until the test timeout:
 * - A bell row is display:block (app.css `.panel .row` beats the flex rule). The link and "Mark read"
 *   then sit past the right edge of a 390px screen. The box still intersects the viewport, so the
 *   control counts as visible, but the middle of the box is not on the element.
 * - The tab bar is position:fixed with z-index 60 and is painted after the dialog scrim, which has the
 *   same z-index. It covers the bottom of a full-screen dialog, so Save and a low checkbox never receive the click.
 *
 * Scroll the control to the centre, then click a point that elementFromPoint says is the control and
 * that sits above the tab bar. The tab bar is found by its landmark (the phone `nav` named "Main",
 * Shell.tsx; the sidebar's nav has no name) and the scroller by its overflow, not by CSS class.
 */
async function pointOn(locator: Locator): Promise<{ x: number; y: number }> {
  const point = await locator.evaluate((el) => {
    const barLimit = () => {
      const nav = document.querySelector('nav[aria-label="Main"]');
      if (!nav || !nav.getClientRects().length) return window.innerHeight;
      // The fixed box that holds the tab bar can be taller than the nav itself.
      let bar: Element = nav;
      for (let up = nav.parentElement; up && up !== document.body; up = up.parentElement) {
        if (getComputedStyle(up).position === "fixed") { bar = up; break; }
      }
      const box = bar.getBoundingClientRect();
      return box.height > 1 ? box.top - 2 : window.innerHeight;
    };
    const scroller = () => {
      for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
        const y = getComputedStyle(up).overflowY;
        if ((y === "auto" || y === "scroll") && up.scrollHeight > up.clientHeight) return up;
      }
      return null;
    };
    const lift = () => {
      const limit = barLimit();
      const rect = el.getBoundingClientRect();
      if (rect.bottom <= limit) return;
      const box = scroller();
      if (box) box.scrollTop += rect.bottom - limit + 8;
    };
    el.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
    lift();
    const scan = () => {
      const box = el.getBoundingClientRect();
      const limit = barLimit();
      const ys = [4, 12, box.height / 2, box.height - 4];
      const xs = [4, 12, box.width / 2, box.width - 4];
      for (const y of ys) {
        for (const x of xs) {
          if (x <= 1 || y <= 1 || x >= box.width - 1 || y >= box.height - 1) continue;
          const cx = box.left + x;
          const cy = box.top + y;
          if (cx < 1 || cy < 1 || cx >= window.innerWidth - 1 || cy >= limit) continue;
          const hit = document.elementFromPoint(cx, cy);
          if (hit && (hit === el || el.contains(hit))) return { x, y };
        }
      }
      return null;
    };
    return scan();
  });
  if (!point) throw new Error("No on-screen point of this control is above the phone tab bar");
  return point;
}

export async function clickClear(locator: Locator) {
  await locator.click({ position: await pointOn(locator), scroll: "none" });
}

export async function setChecked(locator: Locator, checked: boolean) {
  const position = await pointOn(locator);
  if (checked) await locator.check({ position, scroll: "none" });
  else await locator.uncheck({ position, scroll: "none" });
}
