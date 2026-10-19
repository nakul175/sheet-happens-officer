import { Suspense } from "react";
import { CheckEmail } from "./CheckEmail";
export const metadata = { title: "Check your email · Sheet Happens Officer" };

async function Screen({ params }: { params: PageProps<"/check-email">["searchParams"] }) {
  const q = await params;
  return <CheckEmail sendFailed={q.failed === "1"} resent={q.resent === "1"} />;
}

export default function Page({ searchParams }: PageProps<"/check-email">) {
  return (
    <Suspense>
      <Screen params={searchParams} />
    </Suspense>
  );
}
