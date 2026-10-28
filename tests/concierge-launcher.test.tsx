// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConciergeHost, openConcierge } from "@/components/concierge/Launcher";
vi.mock("@/components/concierge/ConciergeProvider", () => ({ useConcierge: () => ({ hidden: false }) }));
vi.mock("@/components/concierge/Concierge", () => ({ Panel: ({ onClose }: { onClose: () => void }) => <button onClick={onClose}>Close</button> }));
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<nav class="tabbar"><button aria-haspopup="menu">More</button></nav><button id="ephemeral">Concierge</button><div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.restoreAllMocks(); });
async function openFromMenu() {
  await act(async () => root.render(<ConciergeHost />));
  const entry = document.getElementById("ephemeral")!;
  entry.focus();
  await act(async () => { openConcierge(); entry.remove(); await vi.advanceTimersByTimeAsync(90); });
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
}
it("returns Close focus to the persistent More entry after the menu item unmounts", async () => {
  await openFromMenu();
  await act(async () => { document.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click(); await vi.advanceTimersByTimeAsync(100); });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement?.textContent).toBe("More");
});
it("Back closes the sheet without leaving the current page", async () => {
  const push = vi.spyOn(window.history, "pushState");
  await openFromMenu();
  expect(push).toHaveBeenCalledOnce();
  await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); await vi.advanceTimersByTimeAsync(100); });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement?.textContent).toBe("More");
});
