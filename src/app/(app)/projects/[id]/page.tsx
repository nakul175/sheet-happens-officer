import { Suspense } from "react";
import ProjectView from "./ProjectView";
export const metadata = { title: "Project · Sheet Happens Officer" };
export default function Page({ params }: PageProps<"/projects/[id]">) { return <Suspense><ProjectView params={params} /></Suspense>; }
