// CRM visibility switch (SHO-E10 to SHO-E13). The last-minute lever for the 19 Oct 2026 launch:
//   CRM_VISIBLE=all     everyone (default)
//   CRM_VISIBLE=admins  only Admins and the Super Admin see Deals, Accounts and the Review screen
//   CRM_VISIBLE=off     nobody; every CRM route answers "not found"
// Changing it needs a restart, not a migration or a deploy of new code.
import { isAdmin, type Actor } from "@/lib/access";
import { notFound } from "@/lib/http";

export type CrmMode = "all" | "admins" | "off";

export function crmMode(): CrmMode {
  const m = (process.env.CRM_VISIBLE ?? "all").trim().toLowerCase();
  return m === "off" || m === "admins" ? m : "all";
}

export function crmVisible(user: Pick<Actor, "orgRole">) {
  const m = crmMode();
  return m === "all" || (m === "admins" && isAdmin(user));
}

/** Throws "not found" so a hidden CRM looks like it does not exist. */
export function requireCrm(user: Pick<Actor, "orgRole">) {
  if (!crmVisible(user)) throw notFound("Page");
}

export const WORKSTREAM_PROJECT = "wst_project";
export const WORKSTREAM_DEAL = "wst_deal";
