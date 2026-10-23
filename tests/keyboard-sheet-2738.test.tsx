// @vitest-environment jsdom
// SHO-2738 (APL-2555 AC5): the phone keyboard half of the AC is the wiring, and the browser suite cannot see it.
// tests/viewport/keyboard-sheet-2738.test.ts lays out static markup and applies `body.vv-sheet` plus --vvh/--vvt itself,
// so it checks the CSS but stays green even if the Modal effect that sets those three things is deleted. This file mounts
// the real Modal and drives a shrinking visualViewport, so the tier fails when the wiring stops happening.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Modal } from "@/components/ui";

const PHONE = 844;
const REMAINING = 508; // the visible area once an iPhone-class keyboard is open

type VV = { height: number; offsetTop: number; addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void };
const resizeListeners = new Set<() => void>();
let vv: VV;
let root: Root | null = null;
let nudged: Mock<(arg?: boolean | ScrollIntoViewOptions) => void>;

/** jsdom has no visualViewport; this is the part of it the dialog uses. */
function visualViewport(height: number, offsetTop = 0): VV {
  return {
    height,
    offsetTop,
    addEventListener: (_t, f) => void resizeListeners.add(f),
    removeEventListener: (_t, f) => void resizeListeners.delete(f),
  };
}

/** What the browser does when the keyboard opens: visualViewport shrinks and fires resize on itself. */
function keyboard(height: number, offsetTop = 0) {
  vv.height = height;
  vv.offsetTop = offsetTop;
  act(() => { for (const f of [...resizeListeners]) f(); });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resizeListeners.clear();
  vv = visualViewport(PHONE);
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  nudged = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
  HTMLElement.prototype.scrollIntoView = nudged;
  document.body.innerHTML = '<div id="root"></div>';
  document.body.className = "";
  document.documentElement.removeAttribute("style");
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.className = "";
  document.documentElement.removeAttribute("style");
  document.body.innerHTML = "";
});

function mount() {
  root = createRoot(document.getElementById("root")!);
  act(() => {
    root!.render(
      <Modal label="Task" onClose={() => {}}>
        <div className="fgrid">Project · To do</div>
        <div className="field"><label htmlFor="desc">Description</label><textarea id="desc" rows={3} /></div>
        <div className="actions"><button className="btn">Mark complete</button></div>
      </Modal>,
    );
  });
  return {
    sheet: document.querySelector<HTMLElement>(".modal")!,
    desc: document.getElementById("desc") as HTMLTextAreaElement,
  };
}

const vvh = () => document.documentElement.style.getPropertyValue("--vvh");

describe("SHO-2738 the dialog tells the sheet where the keyboard is", () => {
  it("marks the page and publishes the visual viewport on the commit that paints the sheet", () => {
    mount();
    expect(document.body.classList.contains("vv-sheet"), "body.vv-sheet is what app.css hangs the phone layout on").toBe(true);
    expect(vvh(), "the sheet is sized from visualViewport, not the layout viewport").toBe(`${PHONE}px`);
    expect(document.documentElement.style.getPropertyValue("--vvt")).toBe("0px");
  });

  it("republishes the height when the keyboard opens, and clears it all on close", () => {
    mount();
    keyboard(REMAINING);
    expect(vvh(), "the sheet follows the visible area down to 508 px").toBe(`${REMAINING}px`);
    keyboard(REMAINING, 24); // iOS also scrolls the visual viewport when it pans to the focused field
    expect(document.documentElement.style.getPropertyValue("--vvt")).toBe("24px");

    act(() => root?.unmount());
    root = null;
    expect(document.body.classList.contains("vv-sheet"), "a closed sheet leaves no phone layout behind").toBe(false);
    expect(vvh()).toBe("");
    expect(document.documentElement.style.getPropertyValue("--vvt")).toBe("");
  });

  it("nudges a focused field back above the pinned footer, and only when it is actually under it", () => {
    const { sheet, desc } = mount();
    // A 508 px sheet whose bottom padding ends 140 px above its bottom edge, so the footer is pinned at 508 - 140 = 368.
    sheet.style.paddingBottom = "140px";
    sheet.getBoundingClientRect = () => ({ top: 0, bottom: PHONE - 336, height: PHONE - 336 } as DOMRect);
    const at = (bottom: number) => () => ({ top: bottom - 44, bottom, height: 44 } as DOMRect);

    keyboard(REMAINING);
    desc.getBoundingClientRect = at(300); // above the pin line: fully visible
    nudged.mockClear();
    act(() => { desc.focus(); document.dispatchEvent(new Event("focusin")); });
    expect(nudged, "a field that is already visible is left where it is").not.toHaveBeenCalled();

    desc.getBoundingClientRect = at(500); // past the pin line: under the footer and the keyboard
    act(() => { document.dispatchEvent(new Event("focusin")); });
    expect(nudged, "a focused field under the footer is scrolled back into the visible area").toHaveBeenCalledWith({ block: "nearest" });
  });
});
