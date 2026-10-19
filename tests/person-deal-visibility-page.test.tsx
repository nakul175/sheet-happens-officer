/**
 * @vitest-environment jsdom
 */
// APL-2728. The person page renders a hidden deal as generic text and does not build
// /projects/<dealId>. A visible deal keeps its name and link. This fails if the row is always a link.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import Person from "@/app/(app)/team/[id]/Person";

const HIDDEN_DEAL_LABEL = "A deal you can't view.";
const DEAL_NAME = "ZZ-TEST Acme renewal";
const DEAL_ID = "zz-deal-2728";
const TASK_TITLE = "ZZ-TEST Acme kickoff";
const PLAIN_NAME = "ZZ-TEST Shared";
const PLAIN_ID = "zz-plain-2728";

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children, className }: { href: string; children?: React.ReactNode; className?: string }) =>
      React.createElement("a", { href, className }, children),
  };
});

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "rep-2728" }),
  usePathname: () => "/team/rep-2728",
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

vi.mock("@/app/(app)/Shell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/(app)/Shell")>();
  return {
    ...actual,
    useMe: () => ({ id: "member-2728", name: "ZZ-TEST member", email: "nakul17+zz-2728-member@aplyd.com", orgRole: "MEMBER" as const }),
  };
});

let root: Root | undefined;

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

async function open(person: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => json({ person })));
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Person />); });
  for (let i = 0; i < 20; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  return document.body;
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("APL-2728 person page DOM", () => {
  it("AC1: a hidden deal is generic text and has no deal href qa:TC missing", async () => {
    const page = await open({
      id: "rep-2728",
      name: "ZZ-TEST rep",
      projects: [
        { id: PLAIN_ID, name: PLAIN_NAME },
        { name: HIDDEN_DEAL_LABEL, href: null },
      ],
    });
    const html = page.innerHTML;
    expect(page.textContent).toContain(HIDDEN_DEAL_LABEL);
    expect(page.textContent?.split(HIDDEN_DEAL_LABEL).length).toBe(2);
    expect(html).not.toContain(DEAL_NAME);
    expect(html).not.toContain(DEAL_ID);
    expect(html).not.toContain(TASK_TITLE);
    expect(html).not.toContain(`/projects/${DEAL_ID}`);
    const sentence = [...page.querySelectorAll("p")].find((p) => p.textContent === HIDDEN_DEAL_LABEL);
    expect(sentence).toBeTruthy();
    expect(sentence?.querySelector("a")).toBeNull();
    expect(page.querySelector("a")?.textContent).not.toBe(HIDDEN_DEAL_LABEL);
    const plain = page.querySelector(`a[href="/projects/${PLAIN_ID}"]`);
    expect(plain?.textContent).toBe(PLAIN_NAME);
  });

  it("AC1: five hidden-deal rows still render one sentence and no link qa:TC missing", async () => {
    const page = await open({
      id: "rep-2728",
      name: "ZZ-TEST rep",
      projects: [
        { id: PLAIN_ID, name: PLAIN_NAME },
        ...Array.from({ length: 5 }, () => ({ name: HIDDEN_DEAL_LABEL, href: null })),
      ],
    });
    expect(page.textContent?.split(HIDDEN_DEAL_LABEL).length).toBe(2);
    expect(page.querySelector(`a[href="/projects/${DEAL_ID}"]`)).toBeNull();
    expect([...page.querySelectorAll("a")].some((a) => a.textContent === HIDDEN_DEAL_LABEL)).toBe(false);
  });

  it("AC2 and AC3: a visible deal keeps its name and /projects/<id> link qa:TC missing", async () => {
    const page = await open({
      id: "rep-2728",
      name: "ZZ-TEST rep",
      projects: [{ id: DEAL_ID, name: DEAL_NAME }],
    });
    const link = page.querySelector(`a[href="/projects/${DEAL_ID}"]`);
    expect(link?.textContent).toBe(DEAL_NAME);
    expect(page.textContent).not.toContain(HIDDEN_DEAL_LABEL);
  });
});
