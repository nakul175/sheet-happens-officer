import { SignInForm } from "./SignInForm";
import { Hero } from "./Hero";
import s from "./signin.module.css";

export const metadata = { title: "Sign in · Sheet Happens Officer" };

export default async function Page({ searchParams }: PageProps<"/signin">) {
  const justReset = (await searchParams).reset === "1";
  return (
    <main className={s.wrap}>
      <div className={s.brandtop}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-mark.svg" alt="" />
        <span>Sheet Happens Officer</span>
      </div>
      <Hero />
      <div className={s.formside}>
        <SignInForm justReset={justReset} />
      </div>
    </main>
  );
}
