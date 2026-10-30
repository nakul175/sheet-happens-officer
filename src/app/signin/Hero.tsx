import s from "./signin.module.css";
export function Hero() {
  return <section className={s.hero}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img className={s.mascot} src="/logo-icon-reversed.svg" width={100} height={100} alt="" />
    <div className={s.brandname}>Sheet Happens Officer</div>
    <span className={s.goldline} aria-hidden="true" />
    <h1 className={s.headline}>This is where sheet happens.</h1>
    <p className={s.support}>Sign in and we will put it in order.</p>
  </section>;
}
