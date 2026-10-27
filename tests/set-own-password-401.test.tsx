// @vitest-environment jsdom
// APL-2652 AC6 (Pam's D13, 6293007880). A 401 on the Set your own password wall goes to
// /signin?expired=1&next=<this page>, the same as api(). With the flag off it stays plain /signin (AC8).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: harness.replace, refresh: () => undefined, push: () => undefined }),
}));

vi.mock("@/components/client", () => ({
  post: vi.fn(async () => ({ ok: false, status: 401, error: "Not signed in", data: {} })),
}));

import { SetOwnPassword } from "@/app/(app)/SetOwnPassword";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const previousEnv = process.env.SIGNIN_RETURN_TO;

async function submitAt(url: string) {
  window.history.replaceState(null, "", url);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<SetOwnPassword email="zz-test-wall@aplyd.com" />); });
  const form = host.querySelector("form");
  expect(form, "the wall renders its form").toBeTruthy();
  await act(async () => { form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}

describe("APL-2652 AC6: a 401 on the Set your own password wall", () => {
  beforeEach(() => {
    harness.replace.mockClear();
    delete process.env.SIGNIN_RETURN_TO;
    delete (window as Window & { __SHO_RETURN_TO?: number }).__SHO_RETURN_TO;
  });
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    delete (window as Window & { __SHO_RETURN_TO?: number }).__SHO_RETURN_TO;
    if (previousEnv === undefined) delete process.env.SIGNIN_RETURN_TO;
    else process.env.SIGNIN_RETURN_TO = previousEnv;
  });

  it("D13 goes to /signin?expired=1 with the current page as next when the return path is on", async () => {
    (window as Window & { __SHO_RETURN_TO?: number }).__SHO_RETURN_TO = 1;
    await submitAt("/tasks/T1?tab=comments#c9");
    expect(harness.replace).toHaveBeenCalledTimes(1);
    expect(harness.replace).toHaveBeenCalledWith("/signin?expired=1&next=%2Ftasks%2FT1%3Ftab%3Dcomments");
  });

  it("D13 keeps a query value's encoding in next", async () => {
    (window as Window & { __SHO_RETURN_TO?: number }).__SHO_RETURN_TO = 1;
    await submitAt("/projects/p1?q=a%20b");
    expect(harness.replace).toHaveBeenCalledWith("/signin?expired=1&next=%2Fprojects%2Fp1%3Fq%3Da%2520b");
  });

  it("AC8 goes to plain /signin when the return path is off", async () => {
    await submitAt("/tasks/T1?tab=comments");
    expect(harness.replace).toHaveBeenCalledWith("/signin");
  });
});
