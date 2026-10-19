// APL-2698 and APL-2716. A hidden deal is replaced with one sentence, so a short name
// such as "A" is never copied into other words. Mail and push never render a stored deal.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HIDDEN_DEAL_TEXT, noticeForReader, redactDealNotice } from "@/lib/feed";

const root = fileURLToPath(new URL("..", import.meta.url));

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "generated") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (/\.(ts|tsx|prisma)$/.test(name)) out.push(full);
  }
  return out;
}

describe("hidden deal notice", () => {
  const stored = {
    type: "DEAL_STAGE_CHANGED",
    actor: null,
    taskId: null,
    projectId: "deal-1",
    data: { project: "A", stage: "A stage", title: "Call Asha", note: "Assigned" },
  };

  it("replaces a one-letter deal with the whole sentence and no link", () => {
    const hidden = noticeForReader(stored, true);
    expect(hidden).toEqual({ text: HIDDEN_DEAL_TEXT, href: null });
    expect(hidden.text).toBe("A deal you can't view was updated.");
    expect(hidden.text).not.toContain("Asha");
    expect(hidden.text).not.toContain("Assigned");
    expect(hidden.text).not.toContain("A stage");
    expect(hidden.href).toBeNull();
  });

  it("builds a visible notice from the stored fields, and a short name stays quoted", () => {
    const stage = noticeForReader(stored, false);
    expect(stage).toEqual({ text: 'Someone moved "A" to A stage.', href: "/projects/deal-1" });
    expect(stage.text).toContain("A stage");
    expect(stage.text).not.toContain("Asha");

    const task = noticeForReader({ ...stored, type: "TASK_ASSIGNED", taskId: "task-1", data: { title: "Call Asha", project: "A" } }, false);
    expect(task).toEqual({ text: 'Someone assigned you "Call Asha".', href: "/tasks/task-1" });
    expect(task.text).toContain("Asha");
    expect(task.text).not.toContain('"A"');
  });
});

const dealName = "ZZ-TEST Acme renewal";

describe.each([
  {
    type: "DEAL_STAGE_CHANGED",
    tc: "qa:TC-APL2716-3abdb652@v1",
    data: { project: dealName, stage: "Proposal" },
    adminText: `Someone moved "${dealName}" to Proposal.`,
    absent: ["Acme", "Proposal"],
  },
  {
    type: "DEAL_NEEDS_NEXT_STEP",
    tc: "qa:TC-APL2716-85782555@v1",
    data: { project: dealName },
    adminText: `"${dealName}" needs a next step.`,
    absent: ["Acme"],
  },
  {
    type: "DEAL_STALLED",
    tc: "qa:TC-APL2716-fcc1861b@v1",
    data: { project: dealName },
    adminText: `"${dealName}" has had no activity for 30 days.`,
    absent: ["Acme"],
  },
])("$type", ({ type, tc, data, adminText, absent }) => {
  const notice = { type, actor: null, taskId: null, projectId: "deal-1", data };

  it(`${tc} redacts a hidden ${type} notice to the generic sentence`, () => {
    expect(redactDealNotice(type)).toEqual({ text: HIDDEN_DEAL_TEXT, href: null });
    const hidden = noticeForReader(notice, true);
    expect(hidden).toEqual({ text: HIDDEN_DEAL_TEXT, href: null });
    for (const word of [dealName, ...absent]) expect(hidden.text, word).not.toContain(word);
    expect(JSON.stringify(hidden)).not.toContain("/projects/");
  });

  it(`${tc} leaves the admin ${type} sentence unchanged`, () => {
    expect(noticeForReader(notice, false)).toEqual({ text: adminText, href: "/projects/deal-1" });
  });
});

describe("deal name is not sent by mail or push", () => {
  it("has no push channel, and mail never reads a stored deal name", () => {
    const src = filesUnder(path.join(root, "src"));
    const texts = src.map((file) => ({ file: path.relative(root, file), text: readFileSync(file, "utf8") }));
    const joined = texts.map((f) => f.text).join("\n");
    expect(joined).not.toMatch(/web-push|webpush|PushSubscription|showNotification/);

    const mailers = texts.filter((f) => f.text.includes("sendMail(") && !f.file.endsWith("src/lib/email.ts"));
    expect(mailers.map((f) => f.file).sort()).toEqual([
      "src/app/api/auth/forgot-password/route.ts",
      "src/app/api/auth/resend-verification/route.ts",
      "src/app/api/auth/signup/route.ts",
      "src/lib/team.ts",
    ]);
    for (const mailer of mailers) {
      expect(mailer.text, mailer.file).not.toMatch(/noticeText|notification\.find|data\.project/);
    }
    const speakers = texts.filter((f) => f.text.includes("noticeText"));
    expect(speakers.map((f) => f.file)).toEqual(["src/lib/feed.ts"]);
  });
});
