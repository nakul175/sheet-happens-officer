// @vitest-environment jsdom
// APL-2720 v1.0. The Time left cell says how many days are left. daysLeft still comes from the API.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import Trash from "@/app/(app)/projects/[id]/trash/Trash";

const PROJECT_ID = "zz-test-project-2720";
const params = Promise.resolve({ id: PROJECT_ID });

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children, className }: { href: string; children?: React.ReactNode; className?: string }) =>
      React.createElement("a", { href, className }, children),
  };
});

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: PROJECT_ID }),
  usePathname: () => `/projects/${PROJECT_ID}/trash`,
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

type Item = {
  id: string;
  title: string;
  isSubtask: boolean;
  parentTitle?: string | null;
  deletedAt: string;
  deletedBy: { name: string } | null;
  daysLeft: number;
};

function item(daysLeft: number, title = "ZZ-TEST Fix invoice", id = `t-${daysLeft}`): Item {
  return {
    id,
    title,
    isSubtask: false,
    deletedAt: "2026-10-01T04:30:00.000Z",
    deletedBy: { name: "QA Leader" },
    daysLeft,
  };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function installFetch(role: string, archived: boolean, items: Item[]) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `/api/projects/${PROJECT_ID}`) {
      return Promise.resolve(json({ project: { name: "ZZ-TEST project", role, archived } }));
    }
    if (url === `/api/projects/${PROJECT_ID}/trash`) return Promise.resolve(json({ items }));
    return Promise.reject(new Error(`unexpected ${url}`));
  }));
}

let root: Root | undefined;

async function show(node: ReactNode) {
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
  return document.body;
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function timeCells(page: ParentNode) {
  return [...page.querySelectorAll('td[data-label="Time left"]')];
}

const WORDS = [
  { n: 30, text: "30 days left" },
  { n: 29, text: "29 days left" },
  { n: 2, text: "2 days left" },
  { n: 1, text: "1 day left" },
  { n: 0, text: "0 days left" },
] as const;

describe("@APL-2720 Trash says how many days are left", () => {
  it.each(WORDS)("@APL-2720 AC1@v1.0 Time left for daysLeft $n reads exactly $text", async ({ n, text }) => {
    installFetch("LEADER", false, [item(n)]);
    const page = await show(<Trash params={params} />);
    const cell = timeCells(page);
    expect(cell).toHaveLength(1);
    expect(cell[0].textContent).toBe(text);
    expect(page.textContent).toContain("ZZ-TEST Fix invoice");
  });

  it("@APL-2720 AC2@v1.0 keeps the Time left header, the API order, and Restore for a Leader", async () => {
    const rows = [
      item(2, "ZZ-TEST two", "a"),
      item(30, "ZZ-TEST thirty", "b"),
      item(0, "ZZ-TEST zero", "c"),
      item(1, "ZZ-TEST one", "d"),
      item(29, "ZZ-TEST twenty-nine", "e"),
    ];
    installFetch("LEADER", false, rows);
    const page = await show(<Trash params={params} />);
    expect(timeCells(page).map((td) => td.textContent)).toEqual([
      "2 days left",
      "30 days left",
      "0 days left",
      "1 day left",
      "29 days left",
    ]);
    expect([...page.querySelectorAll("tbody tr")].map((tr) => tr.querySelector("td")?.textContent)).toEqual([
      "ZZ-TEST two",
      "ZZ-TEST thirty",
      "ZZ-TEST zero",
      "ZZ-TEST one",
      "ZZ-TEST twenty-nine",
    ]);
    expect(page.querySelectorAll("button")).toHaveLength(5);
    expect([...page.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["Item", "Deleted by", "Deleted", "Time left", ""]);
  });

  it.each([
    { role: "EDITOR", archived: false },
    { role: "VIEWER", archived: false },
    { role: "LEADER", archived: true },
  ])("@APL-2720 AC2@v1.0 hides Restore for $role when archived is $archived", async ({ role, archived }) => {
    installFetch(role, archived, [item(30)]);
    const page = await show(<Trash params={params} />);
    expect(timeCells(page)[0].textContent).toBe("30 days left");
    expect(page.querySelector("button")).toBeNull();
  });

  it("@APL-2720 AC2@v1.0 still shows the empty state and the 30-day notice", async () => {
    installFetch("LEADER", false, []);
    const page = await show(<Trash params={params} />);
    expect(page.textContent).toContain("Trash is empty.");
    expect(page.textContent).toContain("Tasks are kept for 30 days, then removed for good.");
    expect(timeCells(page)).toHaveLength(0);
  });

  it("@APL-2720 AC2@v1.0 leaves the daysLeft calculation in listTrash unchanged", () => {
    const tasks = readFileSync("src/lib/tasks.ts", "utf8");
    expect(tasks).toContain("daysLeft: Math.max(0, 30 - Math.floor((now - t.deletedAt!.getTime()) / 86400_000)),");
    let changed: string[] | null;
    try {
      changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean);
    } catch {
      changed = null;
    }
    if (changed && changed.length) {
      expect(changed).not.toContain("src/lib/tasks.ts");
      expect([...changed].sort()).toEqual([
        "src/app/(app)/projects/[id]/trash/Trash.tsx",
        "tests/trash-days-left.test.tsx",
      ]);
    }
  });
});
