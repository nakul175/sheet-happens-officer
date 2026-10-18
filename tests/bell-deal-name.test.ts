// APL-2698. A short deal name is removed only as a whole stored value or a whole quoted name.
// Mail and push never render a stored deal name; the bell is the only sentence builder.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { noticeText, withoutExactDealName, withoutQuotedDealName } from "@/lib/feed";

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

describe("hidden deal name replacement", () => {
  it("removes a one-letter deal name without changing Asha, Assigned or A stage", () => {
    const data = { project: "A", stage: "A stage", title: "Call Asha", note: "Assigned" };
    const stored = withoutExactDealName(data, "A") as Record<string, unknown>;
    expect(stored.project).toBeUndefined();
    expect(stored.stage).toBe("A stage");
    expect(stored.title).toBe("Call Asha");
    expect(stored.note).toBe("Assigned");

    const notice = noticeText({
      type: "DEAL_STAGE_CHANGED",
      actor: null,
      taskId: null,
      projectId: "deal",
      data: stored,
    });
    const text = withoutQuotedDealName(notice.text, "A");
    expect(text).toBe("Someone moved a project to A stage.");
    expect(text).not.toContain('"A"');
    expect(text).toContain("A stage");

    const nearby = withoutQuotedDealName('Someone moved "A" to A stage. Call Asha about the Assigned work.', "A");
    expect(nearby).toBe("Someone moved a project to A stage. Call Asha about the Assigned work.");
    expect(nearby).toContain("Asha");
    expect(nearby).toContain("Assigned");
    expect(nearby).toContain("A stage");
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
