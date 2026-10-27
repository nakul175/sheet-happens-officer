import { notFound } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { workloadAvailable } from "@/lib/workload";
import Workload from "./Workload";

export const metadata = { title: "Workload · Sheet Happens Officer" };
export default async function Page() {
  if (!await workloadAvailable(await currentUser())) notFound();
  return <Workload />;
}
