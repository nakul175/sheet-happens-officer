import { Suspense } from "react";
import OrgView from "./OrgView";
export const metadata = { title: "Organisation · Sheet Happens Officer" };
export default function Page({ params }: PageProps<"/accounts/[id]">) { return <Suspense><OrgView params={params} /></Suspense>; }
