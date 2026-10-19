/**
 * @vitest-environment jsdom
 */
// APL-2738 (APL-2555 AC5): with the keyboard open the task sheet follows visualViewport,
// and the focused description is scrolled back into the visible sheet. No server needed.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { keyboardFrame, Modal } from "@/components/ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
  shrink(height: number, offsetTop = 0) {
    this.height = height;
    this.offsetTop = offsetTop;
    this.dispatchEvent(new Event("resize"));
  }
}

let vv: FakeViewport;
let phone = true;
let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  vv = new FakeViewport();
  phone = true;
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (q: string) => ({ matches: q === "(max-width: 599px)" && phone, media: q, addEventListener() {}, removeEventListener() {} }),
  });
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  vi.restoreAllMocks();
});

function sheet(fitKeyboard: boolean) {
  root = createRoot(host);
  act(() => root!.render(
    <Modal label="Task" fitKeyboard={fitKeyboard} onClose={() => {}}>
      <div className="bar"><button>Close</button></div>
      <textarea id="desc" />
      <div className="actions sheet-foot"><button>Mark complete</button></div>
    </Modal>,
  ));
  return { scrim: document.querySelector<HTMLElement>('[data-testid="modal-scrim"]')!, desc: document.querySelector<HTMLTextAreaElement>("#desc")! };
}

describe("APL-2738 keyboardFrame", () => {
  test("qa:TC-APL2738-02@v1 AC1: on a phone the frame is the visible area, top and height from visualViewport", () => {
    expect(keyboardFrame({ height: 420, offsetTop: 36 }, true)).toEqual({ top: "36px", bottom: "auto", height: "420px" });
  });

  test("qa:TC-APL2738-04@v1 AC1: at 600 px and wider, or with no visualViewport, the stylesheet stays in charge", () => {
    expect(keyboardFrame({ height: 420, offsetTop: 0 }, false)).toBeNull();
    expect(keyboardFrame(null, true)).toBeNull();
    expect(keyboardFrame(undefined, true)).toBeNull();
  });
});

describe("APL-2738 Modal fitKeyboard", () => {
  test("qa:TC-APL2738-02@v1 AC1: the sheet follows visualViewport when the visible area shortens", () => {
    const { scrim } = sheet(true);
    expect(scrim.style.height).toBe("800px");
    act(() => vv.shrink(450, 12));
    expect(scrim.style.top).toBe("12px");
    expect(scrim.style.bottom).toBe("auto");
    expect(scrim.style.height).toBe("450px");
  });

  test("qa:TC-APL2738-01@v1 AC1: the focused description is scrolled back into the sheet on resize", () => {
    const { desc } = sheet(true);
    const into = vi.fn();
    desc.scrollIntoView = into;
    act(() => desc.focus());
    act(() => vv.shrink(450));
    expect(into).toHaveBeenCalledWith({ block: "nearest" });
  });

  test("qa:TC-APL2738-02@v1 AC1: a visualViewport scroll moves the sheet without forcing the field into view", () => {
    const { scrim, desc } = sheet(true);
    const into = vi.fn();
    desc.scrollIntoView = into;
    act(() => desc.focus());
    vv.offsetTop = 80;
    act(() => { vv.dispatchEvent(new Event("scroll")); });
    expect(scrim.style.top).toBe("80px");
    expect(into).not.toHaveBeenCalled();
  });

  test("qa:TC-APL2738-04@v1 AC1: dialogs without fitKeyboard, and wide screens, keep the stylesheet layout", () => {
    const plain = sheet(false);
    act(() => vv.shrink(450));
    expect(plain.scrim.style.height).toBe("");
    act(() => root!.unmount());
    root = null;
    phone = false;
    const wide = sheet(true);
    act(() => vv.shrink(450));
    expect(wide.scrim.style.height).toBe("");
    expect(wide.scrim.style.top).toBe("");
  });

  test("qa:TC-APL2738-03@v1 AC1: closing the sheet clears the inline frame and stops listening", () => {
    const { scrim } = sheet(true);
    act(() => vv.shrink(450));
    act(() => root!.unmount());
    root = null;
    expect(scrim.style.height).toBe("");
    expect(scrim.style.top).toBe("");
  });
});
