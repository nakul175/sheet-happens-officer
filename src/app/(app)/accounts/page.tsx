import AccountsView from "./AccountsView";
import { screenPageState } from "../screen-view-page";
export const metadata = { title: "Accounts · Sheet Happens Officer" };
export default async function Page({ searchParams }: PageProps<"/accounts">) {
  const state = await screenPageState("ACCOUNTS", await searchParams);
  return <AccountsView key={state.key} initialFilters={state.initialFilters} selectedView={state.selectedView} />;
}
