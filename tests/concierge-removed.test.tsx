import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const upsert = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ db: { jobRun: { upsert } } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/my-tasks", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/extras/Extras", () => ({
  Extras: ({ children }: { children: ReactNode }) => children,
  NewTaskButton: () => <button>New task</button>, SearchButton: () => <button>Search</button>,
}));
vi.mock("@/app/(app)/Bell", () => ({ Bell: () => <button>Notifications</button> }));

import { Page, Shell } from "@/app/(app)/Shell";
import { JOBS, runJob } from "@/lib/jobs";
import { wordsToDate } from "@/lib/datewords";
import { logAction } from "@/lib/notify";
import { reqCtx, type ReqCtx } from "@/lib/reqctx";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "generated") return [];
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.(tsx?|css)$/.test(file) ? [file] : [];
  });
}

describe("SHO-3137 Concierge removal", () => {
  it("removes the provider and all retired route handlers instead of merely hiding the UI", () => {
    const routes = ["state", "preferences", "messages", "improve", "quick/[id]", "choices/[messageId]",
      "cards/[cardId]/confirm", "cards/[cardId]/cancel", "cards/[cardId]/undo"];
    for (const route of routes) expect(existsSync(`src/app/api/concierge/${route}/route.ts`)).toBe(false);
    for (const file of ["src/lib/model.ts", "src/lib/usage.ts", "src/app/api/usage/route.ts", "src/app/(app)/usage/page.tsx"])
      expect(existsSync(file), file).toBe(false);
    const source = sourceFiles("src").map((file) => readFileSync(file, "utf8")).join("\n");
    expect(source).not.toMatch(/concierge|ANTHROPIC_API_KEY|MODEL_DATA_APPROVED|api\.anthropic\.com/i);
  });

  it.each(["MEMBER", "ADMIN", "SUPER_ADMIN"] as const)("keeps task/navigation controls for %s without assistant controls or reserved space", (orgRole) => {
    const html = renderToStaticMarkup(<Shell user={{ id: "me", name: "Test Person", email: "test@example.invalid", orgRole, crm: true }}>
      <Page title="My tasks"><button>Task action</button></Page>
    </Shell>);
    expect(html).toContain("My tasks");
    expect(html).toContain("Projects");
    expect(html).toContain("New task");
    expect(html).toContain("Notifications");
    expect(html).toContain("Task action");
    expect(html).not.toMatch(/Concierge|with-dock|with-bar|cc-|href="\/usage"/);
    expect(html.includes('href="/audit"')).toBe(orgRole === "SUPER_ADMIN");
  });

  it("retires chat jobs before any job record or database write", async () => {
    expect(JOBS.map((job) => job.name)).toEqual(["purge-trash", "purge-old", "reminders", "stalled-deals", "check"]);
    for (const job of ["purge-chat", "concierge-budget"]) await expect(runJob(job)).rejects.toMatchObject({ status: 404 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("stops stale host cron entries before secrets are loaded or HTTP is attempted", () => {
    const wrapper = readFileSync("deploy/job.sh", "utf8");
    const retired = wrapper.indexOf('case "$name" in purge-chat|concierge-budget) exit 0 ;; esac');
    expect(retired).toBeGreaterThan(-1);
    expect(retired).toBeLessThan(wrapper.indexOf(". /etc/sho/local.env"));
    for (const file of ["deploy/release.sh", "deploy/cloud-init.yaml"]) {
      expect(readFileSync(file, "utf8")).not.toMatch(/job\.sh (purge-chat|concierge-budget)|install_cron (purge-chat|concierge-budget)/);
    }
  });

  it("keeps quick-add date parsing independent of the removed service", () => {
    const now = new Date("2026-10-21T06:30:00Z");
    expect(wordsToDate("fri", now)).toBe("2026-10-23");
    expect(wordsToDate("tomorrow", now)).toBe("2026-10-22");
    expect(wordsToDate("2026-02-30", now)).toBeNull();
    expect(wordsToDate("soonish", now)).toBeNull();
  });

  it("preserves bulk action log collection and the normal Undo header context", async () => {
    const create = vi.fn().mockResolvedValue({ id: "action-1" });
    const tx = { actionLog: { create } } as unknown as Parameters<typeof logAction>[0];
    const context: ReqCtx = { logIds: [] };
    await reqCtx.run(context, () => logAction(tx, {
      actorId: "me", projectId: "project", targetType: "task", targetId: "task", action: "task.updated",
      before: { title: "Before" }, after: { title: "After" },
    }));
    expect(context.logIds).toEqual(["action-1"]);
    expect(context.undoId).toBe("action-1");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ channel: "SCREEN" }) }));
  });
});
