import { Suspense } from "react";
import Trash from "./Trash";
export const metadata = { title: "Trash · Sheet Happens Officer" };
export default function Page({ params }: PageProps<"/projects/[id]/trash">) { return <Suspense><Trash params={params} /></Suspense>; }
