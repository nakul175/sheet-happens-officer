// SHO-2951 AC2/AC3: the messages figure the usage month reports is the ledger it summarises.
// The defect the ticket names (a test leaving ledger rows behind, a missing figure printing 0) was fixed in
// ef08b5c. This test pins the number itself: one message is one counted ledger row, quick actions are never counted,
// and the total equals both the counted rows in this month and the sum of the per-person figures.
// The month-cap boundary (SHO-3013 pinned the cap) is checked here too: a refused message writes no row, so the
// figure and the rows stay equal while the cap is in force. A real zero-message month stays a real 0, not "no data".
// Seeding goes through the app only (messages through sendMessage with the fake model, quick actions over HTTP).
// afterAll clears the chat, deletes every ledger row this test wrote, and deactivates the person (AC1: a rerun on
// the same DB passes). The person is a ZZ-TEST nakul17+ alias, so every row for them is ours.
import { afterAll, describe, expect, it } from "vitest";
import { usageSummary } from "@/lib/usage";
import { sendMessage } from "@/lib/concierge/engine";
import { clearProviderDown, monthCap, monthSpendUsd } from "@/lib/concierge/limits";
import { monthStartIST, nextMonthStartIST } from "@/lib/concierge/dates";
import { setFakeModel } from "@/lib/model";
import { account, superAdmin, type Account } from "./helpers";
import { actor, db, say, script } from "./concierge-helpers";

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const ENV = ["MODEL_PROVIDER", "MODEL_DATA_APPROVED", "MODEL_RETRY_DELAY_MS", "MONTHLY_CEILING_USD", "WEEKLY_MESSAGE_CAP", "MODEL_NAME"] as const;

describe("qa:TC missing SHO-2951 the usage month message figure is the ledger rows it summarises", () => {
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

  it("qa:TC missing SHO-2951 how many rows the figure counts, and that it survives the safety cap", async () => {
    person = await account(`ZZ-TEST usage figure ${RUN}`, `nakul17+zz-2951-${RUN}@aplyd.com`);
    const sa = { id: person.id, orgRole: "SUPER_ADMIN" as const };
    const now = new Date();
    const monthStart = monthStartIST(now);
    const before = await usageSummary(sa, now);

    // The ledger rows this month, read straight from the table the figure summarises.
    const rows = () => db.modelUsage.findMany({ where: { createdAt: { gte: monthStart } }, select: { userId: true, model: true, counted: true } });
    const counted = async () => (await rows()).filter((r) => r.counted);

    process.env.MODEL_PROVIDER = "fake";
    process.env.MODEL_DATA_APPROVED = "true";
    process.env.MODEL_RETRY_DELAY_MS = "0";
    process.env.MONTHLY_CEILING_USD = "1000000";
    delete process.env.WEEKLY_MESSAGE_CAP;
    delete process.env.MODEL_NAME;
    clearProviderDown();
    script(() => [say("ZZ-TEST ok")]);
    const sent = await sendMessage(actor(person), `ZZ-TEST ledger figure ${RUN}`);
    expect(sent.disabled, JSON.stringify(sent.disabled)).toBeUndefined();
    setFakeModel(null);

    // Two quick actions over HTTP: their ledger rows are not messages.
    for (const id of ["overdue", "overdue"]) {
      const r = await person.c.post(`/api/concierge/quick/${id}`);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    }

    const after = await usageSummary(sa, now);
    const countedRows = await counted();
    const quickRows = (await rows()).filter((r) => r.model.startsWith("quick:"));
    // One message is one counted row. Two quick actions add none: the figure is 1, not 3.
    expect(after.month.messages - before.month.messages).toBe(1);
    expect(countedRows.filter((r) => r.userId === person!.id)).toHaveLength(1);
    expect(quickRows.filter((r) => r.userId === person!.id && r.counted)).toHaveLength(0);
    // The figure is the rows it summarises: month total and per-person rows agree, in total and here.
    expect(after.month.messages).toBe(countedRows.length);
    expect(after.people.reduce((a, p) => a + p.monthMessages, 0)).toBe(after.month.messages);
    const mine = (s: Awaited<ReturnType<typeof usageSummary>>) => s.people.find((p) => p.id === person!.id)?.monthMessages ?? 0;
    expect(mine(after)).toBe(mine(before) + 1);

    // A month with zero messages is a real 0 (the screen prints 0, not "Not counted").
    const fresh = await usageSummary(sa, nextMonthStartIST(now));
    expect(fresh.month.messages).toBe(0);
    // The people list also includes current-week activity. When the month turns during a week,
    // the person can remain listed, but their new-month message figure must be exactly zero.
    expect(fresh.people.find((p) => p.id === person!.id)?.monthMessages ?? 0).toBe(0);

    // SHO-3013 boundary: put the spend above the safety cap. The cap refuses the next message before any row is
    // written, so the figure neither drops nor double counts, and it still equals the counted rows.
    const spend = await monthSpendUsd(now);
    expect(spend).toBeGreaterThan(0);
    process.env.MONTHLY_CEILING_USD = (spend / 2).toFixed(6);
    expect((await monthCap(now))?.code).toBe("MONTH_CAP");
    const blocked = await sendMessage(actor(person), `ZZ-TEST after cap ${RUN}`);
    expect(blocked.disabled?.code).toBe("MONTH_CAP");
    expect(blocked.messages).toHaveLength(0);
    const capped = await usageSummary(sa, now);
    expect(capped.month.messages).toBe(after.month.messages);
    expect(capped.month.messages).toBe((await counted()).length);
    expect(capped.people.reduce((a, p) => a + p.monthMessages, 0)).toBe(capped.month.messages);
  });
});

