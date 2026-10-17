import { Suspense } from "react";
import { AppHome } from "./AppHome";

export default function Home() {
  return (
    <Suspense>
      <AppHome />
    </Suspense>
  );
}
