import ReviewView from "./ReviewView";
import { screenPageState } from "../screen-view-page";
export const metadata = { title: "Review · Sheet Happens Officer" };
export default async function Page({ searchParams }: PageProps<"/review">) {
  const state = await screenPageState("REVIEW", await searchParams);
  return <ReviewView key={state.key} initialFilters={state.initialFilters} selectedView={state.selectedView} />;
}
