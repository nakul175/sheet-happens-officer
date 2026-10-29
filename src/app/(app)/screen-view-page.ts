import { notFound } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { ApiError } from "@/lib/http";
import { filtersFromQuery, type ViewScreen } from "@/lib/screen-view-state";
import { getScreenView } from "@/lib/screen-views";
export async function screenPageState(screen: ViewScreen, sp: Record<string, string | string[] | undefined>) {
  const query = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => v === undefined ? [] : [[k, Array.isArray(v) ? v[0] : v]]));
  const selectedView = query.get("view") || undefined;
  let initialFilters = filtersFromQuery(query);
  if (selectedView) {
    try { initialFilters = (await getScreenView(await currentUser(), selectedView, screen)).state; }
    catch (error) { if (error instanceof ApiError && error.status === 404) notFound(); throw error; }
  }
  return { initialFilters, selectedView, key: selectedView ? `${selectedView}:${JSON.stringify(initialFilters)}` : query.toString() };
}
