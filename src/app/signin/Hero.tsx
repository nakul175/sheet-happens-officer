import type { CSSProperties } from "react";
import s from "./signin.module.css";

type Chip = [text: string, dx: number, dy: number, r: number, d: number];
const lanes: { title: string; chips: Chip[] }[] = [
  { title: "To do", chips: [["Draft the MoRD note", 221, 54, -13, 37], ["Book Kigali flights", 155, 12, -3, 19], ["Review the DPR", 158, -82, -1, 46]] },
  { title: "Doing", chips: [["Costing sheet", -27, 41, -13, 203], ["Partner call notes", -16, 15, -8, 148], ["Brief the team", -21, -87, 3, 92]] },
  { title: "Done", chips: [["Send the Q3 report", -156, 55, -10, 32], ["Update the CRM", -148, 11, 11, 160], ["File expenses", -202, -66, 3, 127]] },
];
const junk: [text: string, left: number, top: number, r: number, d: number][] = [
  ["#REF!", 8, 10, -9, 0], ["final_v7_FINAL.xlsx", 52, 22, 6, 40], ["??", 30, 48, -14, 80], ["=VLOOKUP(", 70, 60, 10, 120],
  ["Sheet1", 12, 74, -5, 160], ["TBD", 84, 12, 12, 200], ["v8_REAL_final", 42, 84, -7, 240], ["#N/A", 64, 38, -11, 280],
];

export function Hero() {
  return (
    <section className={s.hero}>
      <h1 className={s.headline}>This is where sheet happens.</h1>
      <p className={s.support}>Sign in and we will put it in order.</p>
      <div className={s.stage} aria-hidden="true">
        {lanes.map((l) => (
          <div className={s.lane} key={l.title}>
            <div className={s.lh}>{l.title}</div>
            <ul>
              {l.chips.map(([t, dx, dy, r, d]) => (
                <li key={t} className={s.chip} style={{ "--dx": `${dx}px`, "--dy": `${dy}px`, "--r": `${r}deg`, "--d": `${d}ms` } as CSSProperties}>
                  <span className={s.tick} />
                  <span className={s.txt}>{t}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {junk.map(([t, left, top, r, d]) => (
          <span key={t} className={s.junk} style={{ left: `${left}%`, top: `${top}%`, "--jr": `${r}deg`, "--jd": `${d}ms` } as CSSProperties}>
            {t}
          </span>
        ))}
      </div>
    </section>
  );
}
