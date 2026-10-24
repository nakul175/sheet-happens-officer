import { Suspense } from "react";
import Activity from "./Activity";
export const metadata = { title: "Activity · Sheet Happens Officer" };
export default function Page({ params }: PageProps<"/projects/[id]/activity">) { return <Suspense><Activity params={params} /></Suspense>; }
