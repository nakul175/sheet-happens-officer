import { notFound } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { workloadAvailable } from "@/lib/workload";
import WorkloadView from "./WorkloadView";
export const metadata = { title: "Workload · Sheet Happens Officer" };
export default async function WorkloadPage() {
  if (!await workloadAvailable(await currentUser())) notFound();
  return <WorkloadView />;
}
