// @vitest-environment jsdom
// qa:TC-APL2590-aa9679fa@v1. The @ picker is one listbox of options, with no button inside an option.
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Comments } from "@/components/Comments";

const members = [
  { id: "m-lead", name: "Lead" },
  { id: "m-admin", name: "Admin" },
  { id: "m-worker", name: "Worker" },
  { id: "m-viewer", name: "Viewer" },
];

let root: Root | null = null;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  globalThis.fetch = async () => new Response(JSON.stringify({ comments: [], members, canComment: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

async function renderPanel() {
  const host = document.getElementById("root")!;
  root = createRoot(host);
  await act(async () => { root!.render(<Comments taskId="t1" />); });
  await act(async () => { await Promise.resolve(); });
  const box = document.getElementById("new-comment") as HTMLTextAreaElement;
  expect(box).toBeTruthy();
  return box;
}

function typeAt(box: HTMLTextAreaElement, value: string) {
  const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!;
  proto.set!.call(box, value);
  box.selectionStart = value.length;
  act(() => { box.dispatchEvent(new InputEvent("input", { bubbles: true })); });
}

describe("mention picker", () => {
  it("qa:TC-APL2590-aa9679fa@v1: Panel and @ picker meet WCAG 2.2 AA with keyboard and screen reader (axe plus keyboard pass)", async () => {
    const box = await renderPanel();
    typeAt(box, "@");
    const options = [...document.querySelectorAll("#mention-list [role=option]")];
    expect(options.map((o) => o.textContent)).toEqual(["Lead", "Admin", "Worker", "Viewer"]);
    expect(document.querySelector("#mention-list button")).toBeNull();
    expect(options.every((o) => o.querySelector("button, a, input, textarea, select") === null)).toBe(true);

    box.focus();
    act(() => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    expect(document.querySelector("#mention-list [aria-selected=true]")?.textContent).toBe("Admin");
    act(() => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect((document.getElementById("new-comment") as HTMLTextAreaElement).value).toContain("@Admin");

    typeAt(document.getElementById("new-comment") as HTMLTextAreaElement, "@");
    const panel = document.querySelector(".comments")!;
    const result = await axe.run(panel, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
      rules: { "color-contrast": { enabled: false } },
    });
    const nested = result.violations.filter((v) => v.id === "nested-interactive");
    expect(nested, JSON.stringify(nested)).toEqual([]);
    expect(result.violations.map((v) => v.id), JSON.stringify(result.violations)).toEqual([]);
  });
});
