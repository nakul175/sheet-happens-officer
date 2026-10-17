// SHO-US-14.6: J and K move through the rows of a list, Enter opens (the row's own handler), X completes, E assigns.
// Rows are the clickable rows every list already has (role="link" with tabIndex 0), so Enter and the focus ring come for free.
const ROWS = "main [role='link'].item";

const rows = () => [...document.querySelectorAll<HTMLElement>(ROWS)].filter((r) => r.offsetParent !== null);
const current = (all: HTMLElement[]) => {
  const at = document.activeElement as HTMLElement | null;
  const row = at?.closest?.<HTMLElement>(ROWS);
  return row ? all.indexOf(row) : -1;
};

/** Returns true when the key was a list shortcut and did something. */
export function listKey(key: string): boolean {
  const all = rows();
  if (!all.length) return false;
  const at = current(all);
  if (key === "j" || key === "k") {
    // The first row is the implicit start: with nothing chosen yet, J goes to the second row.
    const from = at < 0 ? 0 : at;
    const to = key === "j" ? Math.min(all.length - 1, at < 0 ? 1 : from + 1) : Math.max(0, from - 1);
    all[to].focus();
    return true;
  }
  if (at < 0) return false;
  if (key === "x") {
    const tick = all[at].querySelector<HTMLButtonElement>("button.tick:not(.done):not(.off):not([disabled])");
    if (!tick) return false;
    tick.click();
    return true;
  }
  if (key === "e") {
    all[at].click(); // open the task, then put the cursor on its Assignee
    const t0 = Date.now();
    const look = () => {
      const sel = document.querySelector<HTMLElement>("[aria-modal='true'] select[aria-label='Assignee']");
      if (sel) sel.focus();
      else if (Date.now() - t0 < 3000) setTimeout(look, 100);
    };
    look();
    return true;
  }
  return false;
}
