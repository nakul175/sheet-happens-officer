// CRM visibility switch (SHO-E10 to SHO-E13). The last-minute lever for the 19 Oct 2026 launch:
//   CRM_VISIBLE=all     everyone (default)
//   CRM_VISIBLE=admins  only Admins and the Super Admin see Deals, Accounts and the Review screen
//   CRM_VISIBLE=off     nobody; every CRM route answers "not found"
// Changing it needs a restart, not a migration or a deploy of new code.
// The lever itself is defined in access.ts, where projectAccess applies it to deals and everything in them
// (SHO-BUG-2); `crmProjectWhere` is the matching filter for lists that query projects or tasks directly.
import { crmVisible, type Actor } from "@/lib/access";
import { notFound } from "@/lib/http";

export { WORKSTREAM_DEAL, WORKSTREAM_PROJECT, crmMode, crmProjectWhere, crmVisible, type CrmMode } from "@/lib/access";

/** Throws "not found" so a hidden CRM looks like it does not exist. */
export function requireCrm(user: Pick<Actor, "orgRole">) {
  if (!crmVisible(user)) throw notFound("Page");
}
