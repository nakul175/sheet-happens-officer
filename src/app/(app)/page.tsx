import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Skeleton } from "@/components/ui";
import Dashboard from "./Dashboard";
export const metadata = { title: "Home · Sheet Happens Officer" };
async function HomeContent({ searchParams }: PageProps<"/">) {
  const query = await searchParams;
  if (query.task) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, item);
    redirect(`/my-tasks?${params.toString()}`);
  }
  return <Dashboard />;
}
export default function Home(props: PageProps<"/">) { return <Suspense fallback={<Skeleton />}><HomeContent {...props} /></Suspense>; }
