// @vitest-environment jsdom
// SHO-3025. The flaky APL-2555 AC4 Escape test is not on this baseline (that spec file is absent), so these tests
// pin the dialog's own Escape handling instead: the race and the close path, with no story spec and no live server.
//
// The race is a window, not a delay: the dialog is painted by a commit and the key listener used to be added by a
// passive effect that React runs after that paint. Escape pressed in that window was lost, so the dialog stayed
// open and the test failed - rarely on a fast machine, more often on a loaded one. A dialog that is visible must
// answer Escape, so the listener has to be in place with the commit.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Confirm, Modal } from "@/components/ui";

let root: Root | null = null;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div><button id="row">zz-test row</button>';
  document.body.style.overflow = "";
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.style.overflow = "";
  document.body.innerHTML = "";
});

const key = (opts: { repeat?: boolean } = {}) => new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...opts });

/** A keypress where it really lands: on what has the focus inside the dialog, bubbling up from there. */
const press = (opts: { repeat?: boolean } = {}) => (document.activeElement ?? document.body).dispatchEvent(key(opts));

/** The row the person opened the sheet from: what Escape must give the focus back to. */
const row = () => document.getElementById("row") as HTMLButtonElement;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

describe("SHO-3025 Escape on a dialog", () => {
  it("qa:TC missing answers Escape in the microtask after the commit that paints it, before a post-paint effect", async () => {
    const close = vi.fn();
    const seen = new MutationObserver(() => {
      if (!document.querySelector('[role="dialog"]')) return;
      seen.disconnect();
      press(); // the commit that put the dialog on screen has run; React's post-paint effects have not
    });
    seen.observe(document.body, { childList: true, subtree: true });
    root = createRoot(document.getElementById("root")!);
    // No act(): it flushes passive effects, and this is about the moment between the commit and them.
    root.render(<Modal label="Task" onClose={close}>body</Modal>);
    await new Promise((done) => setTimeout(done, 0));

    expect(dialog(), "the dialog was painted").not.toBeNull();
    expect(close, "Escape in that window is not lost").toHaveBeenCalledTimes(1);
  });

  it("qa:TC missing closes only the dialog on top: one Escape, one close", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    function Stack() {
      const [confirm, setConfirm] = useState(true);
      // TaskModal renders "Move to Trash?" as a sibling of the task sheet, so the two dialogs are siblings too.
      return (
        <>
          <Modal label="Task" onClose={outer}>
            <button type="button">Move to Trash</button>
          </Modal>
          {confirm && <Modal label="Move to Trash?" onClose={() => { setConfirm(false); inner(); }}>confirm</Modal>}
        </>
      );
    }
    root = createRoot(document.getElementById("root")!);
    act(() => { root!.render(<Stack />); });

    act(() => { press(); });

    expect(inner, "the dialog on top closed").toHaveBeenCalledTimes(1);
    expect(outer, "the sheet behind it stayed open").not.toHaveBeenCalled();

    act(() => { press(); });

    expect(outer, "the next Escape closes the sheet").toHaveBeenCalledTimes(1);
    expect(inner, "and does not close the confirm a second time").toHaveBeenCalledTimes(1);
  });

  it("qa:TC missing closes a three-deep stack one dialog at a time, from the top", () => {
    // The AC is one Escape, one dialog - not "the last one opened happens to win". Three are open here, so a
    // listener per dialog (the pre-fix Modal) closes all three on the first press.
    const one = vi.fn();
    const two = vi.fn();
    const three = vi.fn();
    function Stack() {
      const [a, setA] = useState(true);
      const [b, setB] = useState(true);
      const [c, setC] = useState(true);
      return (
        <>
          {a && <Modal label="one" onClose={() => { setA(false); one(); }}>1</Modal>}
          {b && <Modal label="two" onClose={() => { setB(false); two(); }}>2</Modal>}
          {c && <Modal label="three" onClose={() => { setC(false); three(); }}>3</Modal>}
        </>
      );
    }
    root = createRoot(document.getElementById("root")!);
    act(() => { root!.render(<Stack />); });
    expect(Array.from(document.querySelectorAll('[role="dialog"]')).map((d) => d.getAttribute("aria-label")),
      "three dialogs are stacked").toEqual(["one", "two", "three"]);

    act(() => { press(); });
    expect(three, "the top dialog closed").toHaveBeenCalledTimes(1);
    expect(two, "the one under it did not").not.toHaveBeenCalled();
    expect(one, "nor the bottom one").not.toHaveBeenCalled();

    act(() => { press(); });
    expect(two, "the next Escape closes what is now on top").toHaveBeenCalledTimes(1);
    expect(one, "and still not the bottom one").not.toHaveBeenCalled();
    expect(three, "and does not close the top one again").toHaveBeenCalledTimes(1);

    act(() => { press(); });
    expect(one, "the last Escape closes the bottom dialog").toHaveBeenCalledTimes(1);
    expect(two, "each dialog asked to close exactly once").toHaveBeenCalledTimes(1);
    expect(three, "each dialog asked to close exactly once").toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]'), "the stack is empty").toBeNull();
  });

  it("qa:TC missing does not let one Escape also reach another Escape listener on the page", () => {
    const close = vi.fn();
    const behind = vi.fn();
    const drawer = (e: KeyboardEvent) => { if (e.key === "Escape") behind(); };
    document.addEventListener("keydown", drawer); // the drawer or menu that was already open behind the dialog
    try {
      root = createRoot(document.getElementById("root")!);
      act(() => { root!.render(<Modal label="Task" onClose={close}>body</Modal>); });

      act(() => { press(); });

      expect(close, "the dialog answered").toHaveBeenCalledTimes(1);
      expect(behind, "the drawer behind it did not also close").not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", drawer);
    }
  });

  it("qa:TC missing asks to close once for a held key, not once per repeat", () => {
    const close = vi.fn();
    root = createRoot(document.getElementById("root")!);
    act(() => { root!.render(<Modal label="Task" onClose={close}>body</Modal>); });

    act(() => {
      press();
      press({ repeat: true });
      press({ repeat: true });
    });

    expect(close, "one close request, however long the key is held").toHaveBeenCalledTimes(1);
  });

  it("qa:TC missing uses the current onClose after the parent re-renders with a fresh one", () => {
    const first = vi.fn();
    const second = vi.fn();
    root = createRoot(document.getElementById("root")!);
    act(() => { root!.render(<Modal label="Task" onClose={first}>body</Modal>); });
    act(() => { root!.render(<Modal label="Task" onClose={second}>body</Modal>); });

    act(() => { press(); });

    expect(second, "the handler the dialog has now").toHaveBeenCalledTimes(1);
    expect(first, "the one it replaced").not.toHaveBeenCalled();
  });

  it("qa:TC missing gives the focus back to the row and unlocks the page when it closes", () => {
    row().focus();
    const close = vi.fn();
    root = createRoot(document.getElementById("root")!);
    act(() => { root!.render(<Modal label="Task" onClose={close}>body</Modal>); });

    expect(dialog(), "the dialog takes the focus").toBe(document.activeElement);
    expect(document.body.style.overflow, "the page behind is locked").toBe("hidden");

    act(() => root!.unmount());
    root = null;

    expect(row(), "focus returns to the row that opened it").toBe(document.activeElement);
    expect(document.body.style.overflow, "the page scrolls again").toBe("");
  });
});

// The two dialogs a person actually meets: TaskModal renders its sheet as one Modal and the "Move to Trash?" Confirm
// as a sibling of it (src/components/TaskModal.tsx:283), so a single Escape must close the confirm and leave the
// sheet - its scroll lock, its focus and its own Escape - intact.
describe("SHO-3025 a confirm stacked over a dialog", () => {
  it("qa:TC missing closes the confirm only, and the sheet keeps its lock, its focus and its own Escape", () => {
    const sheetCloses = vi.fn();
    const confirmCloses = vi.fn();
    function Sheet() {
      const [confirm, setConfirm] = useState(false);
      const [open, setOpen] = useState(true);
      return (
        <>
          {open && (
            <Modal label="Task" onClose={() => { setOpen(false); sheetCloses(); }}>
              <button type="button" id="trash" onClick={() => setConfirm(true)}>Move to Trash</button>
            </Modal>
          )}
          {confirm && (
            <Confirm title="Move to Trash?" yes="Move to Trash" danger onYes={() => {}}
              onNo={() => { setConfirm(false); confirmCloses(); }} />
          )}
        </>
      );
    }
    row().focus();
    root = createRoot(document.getElementById("root")!);
    act(() => { root!.render(<Sheet />); });
    const trash = document.getElementById("trash") as HTMLButtonElement;
    act(() => { trash.focus(); trash.click(); });

    const labels = () => [...document.querySelectorAll('[role="dialog"]')].map((d) => d.getAttribute("aria-label"));
    expect(labels(), "the sheet, with the confirm over it").toEqual(["Task", "Move to Trash?"]);

    act(() => { press(); });

    expect(confirmCloses, "one Escape closed the dialog on top").toHaveBeenCalledTimes(1);
    expect(sheetCloses, "and not the sheet under it").not.toHaveBeenCalled();
    expect(labels(), "the sheet is still on screen").toEqual(["Task"]);
    expect(document.body.style.overflow, "the sheet still keeps the page from scrolling").toBe("hidden");
    expect(trash, "focus went back into the sheet, to what opened the confirm").toBe(document.activeElement);

    act(() => { press(); });

    expect(sheetCloses, "the sheet's own Escape still closes it").toHaveBeenCalledTimes(1);
    expect(confirmCloses, "each dialog was asked to close exactly once").toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]'), "the stack is empty").toBeNull();
    expect(document.body.style.overflow, "the page scrolls again").toBe("");
    expect(row(), "and the focus is back on the row").toBe(document.activeElement);
  });

  it("qa:TC missing answers for a dialog rendered inside the body of the one under it", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    root = createRoot(document.getElementById("root")!);
    // Rendered as a child, so the inner dialog's element sits inside the outer one's: it is on top because the
    // tree says so, not because it was the last to open (a child's layout effect runs before its parent's).
    act(() => {
      root!.render(
        <Modal label="sheet" onClose={outer}>
          <button type="button">body</button>
          <Modal label="nested" onClose={inner}>nested</Modal>
        </Modal>,
      );
    });

    act(() => { press(); });

    expect(inner, "the nested dialog, the one on top, answered").toHaveBeenCalledTimes(1);
    expect(outer, "the dialog it is rendered inside did not").not.toHaveBeenCalled();
  });
});
