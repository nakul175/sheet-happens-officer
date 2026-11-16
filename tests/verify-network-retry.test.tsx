// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Verify } from "../src/app/verify/Verify";

const harness = vi.hoisted(() => ({ replace: vi.fn(), post: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: harness.replace }), useSearchParams: () => new URLSearchParams("token=synthetic-valid-shape") }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/components/AuthShell", () => ({ AuthShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/client", () => ({ post: harness.post }));

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); root = undefined; host?.remove(); harness.replace.mockReset(); harness.post.mockReset(); vi.unstubAllGlobals(); });

it("keeps a verification link available for retry after a network failure", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.post.mockResolvedValueOnce({ ok: false, status: 0, error: "Could not reach the server." })
    .mockResolvedValueOnce({ ok: true, status: 200 });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<Verify />); });
  const button = () => [...host.querySelectorAll("button")].find(node => node.textContent === "Verify my email")!;
  await act(async () => { button().click(); });
  expect(harness.post).toHaveBeenCalledTimes(1);
  expect(harness.replace).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/try again/i);
  expect(button().disabled).toBe(false);
  await act(async () => { button().click(); });
  expect(harness.post).toHaveBeenCalledTimes(2);
  expect(host.querySelector("h1")?.textContent).toBe("Email verified");
});

it("still sends an invalid verification token to the expired-link screen", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.post.mockResolvedValueOnce({ ok: false, status: 400 });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<Verify />); });
  await act(async () => { host.querySelector("button")!.click(); });
  expect(harness.replace).toHaveBeenCalledWith("/expired");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
