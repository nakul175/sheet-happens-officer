import { describe, expect, it } from "vitest";
import { auditEventMayCarryIp } from "./e2e/helpers/audit-ip-contract";
describe("audit IP acceptance scope", () => {
  it("preserves the explicit sign-in and APL2742 verification security events", () => {
    for (const event of ["SIGN_IN", "SIGN_IN_FAILED", "SIGN_IN_LOCKED", "SIGN_IN_REFUSED", "EMAIL_VERIFIED", "VERIFY_EMAIL_REQUESTED"]) expect(auditEventMayCarryIp(event)).toBe(true);
  });
  it("does not permit IP on work, account, sign-out or arbitrary lookalike events", () => {
    for (const event of ["TASK_DELETED", "TASK_RESTORED", "PROJECT_CREATED", "MEMBER_ADDED", "ORG_ROLE_CHANGED", "ACCOUNT_CREATED", "PASSWORD_RESET", "SIGN_OUT", "SIGN_IN_ORG_ROLE_CHANGED", "EMAIL_VERIFIED_EXTRA", "VERIFY_EMAIL_REQUESTED_EXTRA", ""]) expect(auditEventMayCarryIp(event), event).toBe(false);
  });
});
