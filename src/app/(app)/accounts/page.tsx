import { Suspense } from "react";
import AccountsView from "./AccountsView";
export const metadata = { title: "Accounts · Sheet Happens Officer" };
export default function Page() { return <Suspense><AccountsView /></Suspense>; }
