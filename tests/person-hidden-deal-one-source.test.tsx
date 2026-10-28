/**
 * @vitest-environment jsdom
 */
// SHO-2872. The person page used to draw its own copy of the hidden-deal sentence
// (Person.tsx:12 HIDDEN_DEAL_SENTENCE) beside the model's copy (team.ts HIDDEN_DEAL_LABEL).
// Both read "A deal you can't view." so nothing looked wrong - until one side was reworded and
// a test asserting on the sentence passed against whichever copy it happened to read.
//
// This file guards the shape, not today's wording: the page must print the value the model put in
// the payload row, so rewording the model reaches the screen and a second copy cannot survive.
// The canonical string is imported from the model, never restated here.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import Person from "@/app/(app)/team/[id]/Person";
import { HIDDEN_DEAL_LABEL } from "@/lib/team";

const PLAIN_NAME = "ZZ-TEST Shared";
const PLAIN_ID = "zz-plain-2872";

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children, className }: { href: string; children?: React.ReactNode; className?: string }) =>
      React.createElement("a", { href, className }, children),
  };
});

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "rep-2872" }),
  usePathname: () => "/team/rep-2872",
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

vi.mock("@/app/(app)/Shell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/(app)/Shell")>();
  return {
    ...actual,
    useMe: () => ({ id: "member-2872", name: "ZZ-TEST member", email: "nakul17+zz-2872-member@aplyd.com", orgRole: "MEMBER" as const }),
  };
});

let root: Root | undefined;

async function open(person: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ person }), { status: 200, headers: { "content-type": "application/json" } })));
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

/** The sentences this page prints, one per <p>, trimmed. */
const paragraphs = (page: HTMLElement) => [...page.querySelectorAll("p")].map((p) => (p.textContent ?? "").trim()).filter(Boolean);

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SHO-2872 the person page has one source for the hidden-deal sentence", () => {
  it("prints the model's own sentence for the row the model emits (name only, href null)", async () => {
    const page = await open({
      id: "rep-2872",
      name: "ZZ-TEST rep",
      // Exactly the row getPerson appends from hiddenDealNotice(): the sentence travels as `name`.
      projects: [{ id: PLAIN_ID, name: PLAIN_NAME }, { name: HIDDEN_DEAL_LABEL, href: null }],
    });
    expect(page.textContent?.split(HIDDEN_DEAL_LABEL).length).toBe(2); // once: nothing duplicates it
    const sentence = [...page.querySelectorAll("p")].find((p) => p.textContent === HIDDEN_DEAL_LABEL);
    expect(sentence).toBeTruthy();
    expect(sentence?.querySelector("a")).toBeNull();
  });

  it("follows a reworded model sentence instead of printing a copy of its own", async () => {
    // What a reword on the model side looks like to this page: same row shape, new words.
    // A page holding its own literal keeps printing the old sentence and fails here.
    const reworded = `${HIDDEN_DEAL_LABEL} (reworded)`;
    const page = await open({
      id: "rep-2872",
      name: "ZZ-TEST rep",
      projects: [{ id: PLAIN_ID, name: PLAIN_NAME }, { name: reworded, href: null }],
    });
    expect(page.textContent).toContain(reworded);
    expect(paragraphs(page)).not.toContain(HIDDEN_DEAL_LABEL);
  });

  it("prints the sentence once however many hidden-deal rows arrive", async () => {
    const page = await open({
      id: "rep-2872",
      name: "ZZ-TEST rep",
      projects: [{ id: PLAIN_ID, name: PLAIN_NAME }, ...Array.from({ length: 5 }, () => ({ name: HIDDEN_DEAL_LABEL, href: null }))],
    });
    expect(paragraphs(page).filter((t) => t === HIDDEN_DEAL_LABEL)).toHaveLength(1);
    expect(page.textContent?.split(HIDDEN_DEAL_LABEL).length).toBe(2);
  });
});
