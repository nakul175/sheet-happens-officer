import { Suspense } from "react";
import Activity from "./Activity";
export const metadata = { title: "Activity · Tasks by aplyd" };
export default function Page({ params }: PageProps<"/projects/[id]/activity">) { return <Suspense><Activity params={params} /></Suspense>; }
