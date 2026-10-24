import { readFileSync, lstatSync } from "node:fs";
import { expect } from "@playwright/test";
import { BASE_URL } from "../base-url";
/** A distinct stage fixture runner supplies actual aged API/UI proof; local receipts cannot satisfy this gate. */
export function assertStagingAgeReceipt(issue: "2505" | "2526") {
  const file = process.env.SHO_STAGING_AGE_RECEIPT;
  if (!file) throw new Error("Age acceptance requires SHO_STAGING_AGE_RECEIPT from the reviewed slot9 owned-fixture runner. Run local proof separately with playwright.owned-local.config.ts; absent staging proof is NOT a pass.");
  const st = lstatSync(file);
  expect(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o077) === 0).toBe(true);
  const receipt = JSON.parse(readFileSync(file, "utf8"));
  expect(receipt.scope).toBe("SLOT9_OWNED_AGE_ACCEPTANCE");
  expect(receipt.url).toBe(BASE_URL.replace(/\/$/, ""));
  expect(process.env.EXPECTED_RELEASE).toMatch(/^[a-f0-9]{40}$/);
  expect(receipt.sha).toBe(process.env.EXPECTED_RELEASE);
  expect(receipt.failed).not.toBe(true);
  expect(receipt.cleanupFailed).not.toBe(true);
  expect(receipt.cases[issue]).toBe(true);
  expect(receipt.timestampsRestored).toBe(true);
  expect(receipt.projectArchived).toBe(true);
  expect(receipt.sessionClosed).toBe(true);
  expect(receipt.newActiveMemberSessions).toBe(0);
  expect(receipt.preservation.preserved66).toBe(true);
  expect(receipt.preservation.existingSessionsPreserved).toBe(true);
  expect(receipt.preservation.newActiveBaselineSessions).toBe(0);
}
