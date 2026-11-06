import { Suspense } from "react";
import Members from "./Members";
export const metadata = { title: "Settings · Tasks by aplyd" };
export default function Page({ params }: PageProps<"/projects/[id]/members">) { return <Suspense><Members params={params} /></Suspense>; }
