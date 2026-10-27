// APL-2641 AC3: on the 1st of a month (India time) the Usage figures start at zero.
// Quick actions stay out of the message total (AC2). The screen prints whatever /api/usage returns.
// Seeding goes through the app only, never the database: quick actions over HTTP (POST /api/concierge/quick/:id)
// and messages through sendMessage with the fake model. The test server runs without a model, so it refuses an
// HTTP message send. The person is a ZZ-TEST nakul17+ alias. afterAll clears the chat and deactivates the person
// through the API, then deletes the ledger rows this test wrote: no route deletes usage history, and leaving them
// behind inflates later month figures (SHO-2951). The alias belongs to no one else, so every row for them is ours.
// Other suites write to this month's ledger too, so this month's figures are checked as before-and-after deltas.
import { afterAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { usageSummary } from "@/lib/usage";
import { sendMessage } from "@/lib/concierge/engine";
import { clearProviderDown } from "@/lib/concierge/limits";
import { nextMonthStartIST } from "@/lib/concierge/dates";
import { QUICK_ACTIONS } from "@/lib/concierge/reads";
import { setFakeModel } from "@/lib/model";
import { UsageContents } from "@/app/(app)/usage/screen";
import { account, superAdmin, type Account } from "./helpers";
import { actor, db, say, script } from "./concierge-helpers";

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const ENV = ["MODEL_PROVIDER", "MODEL_DATA_APPROVED", "MODEL_RETRY_DELAY_MS", "MONTHLY_CEILING_USD", "WEEKLY_MESSAGE_CAP", "MODEL_NAME"] as const;

describe("qa:TC missing APL-2641 Usage figures reset on the 1st, India time (AC2 AC3 AC4)", () => {
  let person: Account | undefined;
  const saved = new Map(ENV.map((k) => [k, process.env[k]]));

  afterAll(async () => {
    setFakeModel(null);
    clearProviderDown();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const problems: string[] = [];
    if (person) {
      const cleared = await person.c.del("/api/concierge/messages");
      if (cleared.status !== 200) problems.push(`clear chat: ${cleared.status}`);
      // SHO-2951: no API route deletes usage history, so the ledger rows this test wrote are removed directly.
      // Every row for this alias comes from the two messages and three quick actions above.
      await db.modelUsage.deleteMany({ where: { userId: person.id } });
      const left = await db.modelUsage.count({ where: { userId: person.id } });
      if (left) problems.push(`usage rows left for ${person.email}: ${left}`);
      const sa = await superAdmin();
      const off = await sa.c.post(`/api/team/${person.id}/deactivate`, { reassign: "leaders" });
      if (off.status !== 200) problems.push(`deactivate ${person.email}: ${off.status} ${JSON.stringify(off.json)}`);
    }
    await db.$disconnect();
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("qa:TC missing AC2 AC3: counts this month's messages and quick actions, keeps them apart, and starts from zero at 00:00 IST on the 1st", async () => {
    person = await account(`ZZ-TEST usage month ${RUN}`, `nakul17+zz-2641-${RUN}@aplyd.com`);
    // usageSummary only reads the ledger; the role is what it checks.
    const sa = { id: person.id, orgRole: "SUPER_ADMIN" as const };
    const firstOfNext = nextMonthStartIST(new Date());
    const lastSecond = new Date(firstOfNext.getTime() - 1000);

    const count = (s: Awaited<ReturnType<typeof usageSummary>>, id: string) => s.quickActions.find((q) => q.id === id)?.count ?? 0;
    const before = await usageSummary(sa, lastSecond);

    // Two ZZ-TEST messages, each one model call with the fake provider.
    process.env.MODEL_PROVIDER = "fake";
    process.env.MODEL_DATA_APPROVED = "true";
    process.env.MODEL_RETRY_DELAY_MS = "0";
    process.env.MONTHLY_CEILING_USD = "1000000";
    delete process.env.WEEKLY_MESSAGE_CAP;
    delete process.env.MODEL_NAME;
    clearProviderDown();
    script(() => [say("ZZ-TEST ok")]);
    for (const text of [`ZZ-TEST first message ${RUN}`, `ZZ-TEST second message ${RUN}`]) {
      const sent = await sendMessage(actor(person), text);
      expect(sent.disabled, JSON.stringify(sent.disabled)).toBeUndefined();
    }
    setFakeModel(null);

    // Three quick actions over HTTP: two Overdue and one Blocked.
    for (const id of ["overdue", "overdue", "blocked"]) {
      const r = await person.c.post(`/api/concierge/quick/${id}`);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    }

    const thisMonth = await usageSummary(sa, lastSecond);
    // AC2: three quick actions do not add to the message total.
    expect(thisMonth.month.messages - before.month.messages).toBe(2);
    expect(thisMonth.people.find((p) => p.id === person!.id)?.monthMessages).toBe(2);
    expect(count(thisMonth, "overdue") - count(before, "overdue")).toBe(2);
    expect(count(thisMonth, "blocked") - count(before, "blocked")).toBe(1);
    for (const q of QUICK_ACTIONS.filter((q) => q.id !== "overdue" && q.id !== "blocked")) {
      expect(count(thisMonth, q.id) - count(before, q.id), q.id).toBe(0);
    }

    // AC3: at 00:00 IST on the 1st of next month, nothing from this month counts.
    const fresh = await usageSummary(sa, firstOfNext);
    expect(fresh.monthStart).toBe(firstOfNext.toISOString());
    expect(fresh.month.messages).toBe(0);
    expect(fresh.month.calls).toBe(0);
    expect(fresh.month.inputTokens).toBe(0);
    expect(fresh.month.outputTokens).toBe(0);
    expect(fresh.month.costUsd).toBe(0);
    expect(fresh.ceiling.spendUsd).toBe(0);
    // The people list is the union of this month and this week. At a month boundary the same
    // calendar week can still contain earlier activity, so the person may remain with a zero
    // month figure while their week figure is non-zero.
    expect(fresh.people.find((p) => p.id === person!.id)?.monthMessages ?? 0).toBe(0);
    expect(fresh.people.find((p) => p.id === person!.id)?.monthCalls ?? 0).toBe(0);
    expect(fresh.people.find((p) => p.id === person!.id)?.monthCostUsd ?? 0).toBe(0);
    expect(fresh.quickActions.map((q) => q.id)).toEqual(QUICK_ACTIONS.map((q) => q.id));
    expect(fresh.quickActions.every((q) => q.count === 0)).toBe(true);

    const html = renderToStaticMarkup(<UsageContents role="SUPER_ADMIN" loading={false} error={null} data={fresh} />);
    expect(html).toMatch(/Messages this month<\/h2>\s*<p class="usage-count">0<\/p>/);
    for (const q of fresh.quickActions) expect(html).toContain(`<dt>${q.label}</dt><dd>0</dd>`);

    // AC4: only the Super Admin gets figures.
    await expect(usageSummary({ id: person.id, orgRole: "ADMIN" }, firstOfNext)).rejects.toMatchObject({ status: 404 });
    await expect(usageSummary({ id: person.id, orgRole: "MEMBER" }, firstOfNext)).rejects.toMatchObject({ status: 404 });
  });
});
