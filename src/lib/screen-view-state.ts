// Safe, screen-specific filter values. A view carries no result rows or access grants.
import { z } from "zod";
export const screens = z.enum(["DEALS", "ACCOUNTS", "REVIEW"]);
export type ViewScreen = z.infer<typeof screens>;
export const screenFilters = z.object({
  q: z.string().max(200).default(""), pipelineId: z.string().max(60).default(""), stageId: z.string().max(60).default(""),
  organisationId: z.string().max(60).default(""), leaderId: z.string().max(60).default(""),
  atRisk: z.boolean().default(false), kind: z.string().max(100).default(""), country: z.string().max(100).default(""),
  mine: z.boolean().default(false), archived: z.boolean().default(false), layout: z.enum(["board", "list"]).default("board"),
});
export type ScreenFilters = z.infer<typeof screenFilters>;
export const screenViewInput = z.object({
  screen: screens, name: z.string().trim().min(1).max(40), state: screenFilters,
  scope: z.enum(["PRIVATE", "WORKSPACE", "PROJECT"]).default("PRIVATE"), projectId: z.string().min(1).max(60).nullable().default(null),
}).refine(v => (v.scope === "PROJECT") === !!v.projectId, { message: "Choose a project only for a project-shared view.", path: ["projectId"] });
export function filtersFromQuery(q: URLSearchParams): ScreenFilters {
  const result = screenFilters.safeParse({ ...Object.fromEntries(q), atRisk: q.get("atRisk") === "true", mine: q.get("mine") === "true", archived: q.get("archived") === "true", layout: q.get("layout") === "list" ? "list" : "board" });
  return result.success ? result.data : screenFilters.parse({});
}
export const screenPath = (screen: ViewScreen) => ({ DEALS: "/deals", ACCOUNTS: "/accounts", REVIEW: "/review" })[screen];
export function screenViewHref(screen: ViewScreen, state: unknown, id?: string) {
  const s = screenFilters.parse(state);
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(s)) if (value !== "" && value !== false && !(key === "layout" && value === "board")) q.set(key, String(value));
  if (id) q.set("view", id);
  return `${screenPath(screen)}?${q}`;
}
