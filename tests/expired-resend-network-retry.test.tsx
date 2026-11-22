// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ResendLink } from "../src/app/expired/ResendLink";

const harness = vi.hoisted(() => ({ push: vi.fn(), post: vi.fn(), recalledEmail: vi.fn(() => "person@example.test") }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: harness.push }) }));
vi.mock("@/components/client", () => ({ post: harness.post, recalledEmail: harness.recalledEmail }));

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount()); root = undefined; host?.remove();
  harness.push.mockReset(); harness.post.mockReset(); harness.recalledEmail.mockReset();
  vi.unstubAllGlobals();
});

it("keeps an expired-link resend on screen for retry when the request never reaches the API", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.recalledEmail.mockReturnValue("person@example.test");
  harness.post.mockResolvedValueOnce({ ok: false, status: 0 }).mockResolvedValueOnce({ ok: true, status: 200 });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<ResendLink />); });
  const button = () => host.querySelector("button")!;
  await act(async () => { button().click(); });
  expect(harness.post).toHaveBeenCalledTimes(1);
  expect(harness.push).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/try again/i);
  expect(button().disabled).toBe(false);
  await act(async () => { button().click(); });
  expect(harness.post).toHaveBeenCalledTimes(2);
  expect(harness.push).toHaveBeenCalledWith("/check-email?resent=1");
});
