import type { Actor } from "../src/lib/access";
export { db } from "../src/lib/db";

/** Signed-in actor used by shared task/CRM tests, independent of any assistant. */
export const actor = (account: { id: string }, orgRole: Actor["orgRole"] = "MEMBER"): Actor => ({ id: account.id, orgRole });
