import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { hashToken, issueTokenAndSend, usableToken } from "@/lib/auth";
import { getOrCreateWorkspace } from "@/lib/workspace";

const fixture = randomUUID();
const cases = (["RESET", "VERIFY"] as const).flatMap(type => [false, true].map(reverse => ({
  type, reverse, userId: `delivery-${type.toLowerCase()}-${reverse ? "reverse" : "forward"}-${fixture}`,
})));
const sentinelId = `delivery-sentinel-${fixture}`;
let safe = false;
let sentinelBefore: unknown;
const outcomes: string[] = [];

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/sho_test")
    throw new Error("LOCAL_DISPOSABLE_SHO_TEST_REQUIRED");
  safe = true;
  const workspaceId = (await getOrCreateWorkspace()).id;
  await db.user.createMany({ data: [
    ...cases.map(({ userId }) => ({ id: userId, workspaceId, name: "Synthetic delivery ordering", email: `nakul17+zz-${userId}@aplyd.com`, passwordHash: "unused" })),
    { id: sentinelId, workspaceId, name: "Synthetic unrelated sentinel", email: `nakul17+zz-${sentinelId}@aplyd.com`, passwordHash: "sentinel" },
  ] });
  sentinelBefore = await db.user.findUniqueOrThrow({ where: { id: sentinelId } });
});

afterAll(async () => {
  if (!safe) return;
  expect(await db.user.findUniqueOrThrow({ where: { id: sentinelId } })).toEqual(sentinelBefore);
  const ids = cases.map(({ userId }) => userId);
  await db.auditLog.deleteMany({ where: { actorId: { in: ids } } });
  await db.authToken.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: [...ids, sentinelId] } } });
  expect(await db.auditLog.count({ where: { actorId: { in: ids } } })).toBe(0);
  expect(await db.authToken.count({ where: { userId: { in: ids } } })).toBe(0);
  expect(await db.user.count({ where: { id: { in: [...ids, sentinelId] } } })).toBe(0);
  mkdirSync("test-results/auth-delivery-order", { recursive: true });
  writeFileSync("test-results/auth-delivery-order/cleanup.json", JSON.stringify({ fixture, outcomes, cases: cases.length, usersRemoved: cases.length + 1, tokenRowsRemaining: 0, auditRowsRemaining: 0 }, null, 2));
  await db.$disconnect();
});

it.each(cases)("SHO-REG-AUTH-08 $type $reverse: latest delivered link survives completion order", async ({ type, reverse, userId }) => {
  let rawA = "", rawB = "";
  let releaseA!: () => void, releaseB!: () => void;
  const gateA = new Promise<void>(resolve => { releaseA = resolve; });
  const gateB = new Promise<void>(resolve => { releaseB = resolve; });
  const sendA = issueTokenAndSend(userId, type, token => {
    rawA = token;
    return gateA;
  });
  let sendB: Promise<string> | undefined;
  try {
    await vi.waitFor(() => expect(rawA).not.toBe(""));
    // Make the reservation order unambiguous even on a millisecond-resolution clock.
    await db.authToken.update({ where: { tokenHash: hashToken(rawA) }, data: { createdAt: new Date(0) } });
    sendB = issueTokenAndSend(userId, type, token => {
      rawB = token;
      return gateB;
    });
    await vi.waitFor(() => expect(rawB).not.toBe(""));
    expect(await db.authToken.count({ where: { userId, type } })).toBe(2);

    if (reverse) {
      releaseB(); await sendB;
      expect(await usableToken(rawB, type)).not.toBeNull();
      releaseA(); await sendA;
    } else {
      releaseA(); await sendA;
      expect(await usableToken(rawA, type)).not.toBeNull();
      releaseB(); await sendB;
    }
    expect(await usableToken(rawB, type)).not.toBeNull();
    expect(await usableToken(rawA, type)).toBeNull();
    outcomes.push(`${type}:${reverse ? "reverse" : "forward"}:PASS`);
  } finally {
    releaseA(); releaseB();
    await Promise.allSettled(sendB ? [sendA, sendB] : [sendA]);
  }
});
