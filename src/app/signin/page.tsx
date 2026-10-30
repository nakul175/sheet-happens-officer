import { Suspense } from "react";
import { returnToEnabled, safeReturnPath } from "@/lib/return-to";
import { ReturnToBridge } from "@/components/ReturnToBridge";
import { SignInForm } from "./SignInForm";
import { Hero } from "./Hero";
import s from "./signin.module.css";

export const metadata = { title: "Sign in · Sheet Happens Officer" };

async function Form({ params }: { params: PageProps<"/signin">["searchParams"] }) {
  const sp = await params;
  const bridge = typeof sp.returnTo === "string" && sp.returnTo.startsWith("/api/suite/authorize?");
  const centralEnabled = process.env.APLYD_ACCOUNTS_SSO === "true" && !bridge;
  if (!returnToEnabled()) return <SignInForm justReset={sp.reset === "1"} centralEnabled={centralEnabled} />;
  const next = safeReturnPath(typeof sp.next === "string" ? sp.next : undefined, 1) ?? undefined;
  return (
    <>
      <ReturnToBridge />
      <SignInForm justReset={sp.reset === "1"} centralEnabled={centralEnabled} sessionExpired={sp.expired === "1"} next={next} />
    </>
  );
}

export default function Page({ searchParams }: PageProps<"/signin">) {
  return (
    <main className={s.wrap}>
      <div className={s.brandtop}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-icon-reversed.svg" width={40} height={40} alt="" />
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
