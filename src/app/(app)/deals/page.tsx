import DealsView from "./DealsView";
import { screenPageState } from "../screen-view-page";
export const metadata = { title: "Deals · Sheet Happens Officer" };
export default async function Page({ searchParams }: PageProps<"/deals">) {
  const state = await screenPageState("DEALS", await searchParams);
  return <DealsView key={state.key} initialFilters={state.initialFilters} selectedView={state.selectedView} />;
}
