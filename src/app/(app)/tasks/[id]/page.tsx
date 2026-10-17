import { Suspense } from "react";
import TaskPage from "./TaskPage";
export const metadata = { title: "Task · Sheet Happens Officer" };
export default function Page({ params }: PageProps<"/tasks/[id]">) { return <Suspense><TaskPage params={params} /></Suspense>; }
