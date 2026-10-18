import { Suspense } from "react";
import { returnToEnabled, safeReturnPath } from "@/lib/return-to";
import { ReturnToBridge } from "@/components/ReturnToBridge";
import { SignInForm } from "./SignInForm";
import { Hero } from "./Hero";
import s from "./signin.module.css";

export const metadata = { title: "Sign in · Sheet Happens Officer" };

async function Form({ params }: { params: PageProps<"/signin">["searchParams"] }) {
  const sp = await params;
  // Flag off ignores next and expired, so sign-in lands on the home page as it does on main.
  if (!returnToEnabled()) return <SignInForm justReset={sp.reset === "1"} />;
  // Only a safe path is handed to the form. A bad `next` is dropped, so sign-in goes home.
  const next = safeReturnPath(typeof sp.next === "string" ? sp.next : undefined) ?? undefined;
  return (
    <>
      <ReturnToBridge />
      <SignInForm justReset={sp.reset === "1"} sessionExpired={sp.expired === "1"} next={next} />
    </>
  );
}

export default function Page({ searchParams }: PageProps<"/signin">) {
  return (
    <main className={s.wrap}>
      <div className={s.brandtop}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-mark.svg" alt="" />
        <span>Sheet Happens Officer</span>
      </div>
      <Hero />
      <div className={s.formside}>
        <Suspense>
          <Form params={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}
