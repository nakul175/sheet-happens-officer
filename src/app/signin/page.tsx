import { Suspense } from "react";
import { SignInForm } from "./SignInForm";
import { Hero } from "./Hero";
import s from "./signin.module.css";

export const metadata = { title: "Sign in · Sheet Happens Officer" };

async function Form({ params }: { params: PageProps<"/signin">["searchParams"] }) {
  const query = await params;
  const bridge = typeof query.returnTo === "string" && query.returnTo.startsWith("/api/suite/authorize?");
  return <SignInForm justReset={query.reset === "1"} centralEnabled={process.env.APLYD_ACCOUNTS_SSO === "true" && !bridge} />;
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
