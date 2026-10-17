import { Suspense } from "react";
import { SignInForm } from "./SignInForm";
export const metadata = { title: "Sign in · Sheet Happens Officer" };
export default function Page() { return <Suspense><SignInForm /></Suspense>; }
