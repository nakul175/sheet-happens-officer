// APL-2519 AC6. One place for the percentage used.
// The screen prints percentUsedLabel(spend, ceiling). It does not echo ceiling.percent, so a payload
// that still carries the old one-decimal figure (10 of 80 stored as 12.5, or 1 of 101 stored as 1)
// still shows 13% and <1%.
// GET /api/usage stores the matching whole number in ceiling.percent (0 when the label is "0%" or "<1%",
// and 0 when no ceiling is set).
// AC6 v1.1: a ceiling of 0 or unset shows "No ceiling set" and no percentage; spend over the ceiling
// shows the rounded percentage plus an "Over ceiling" flag.

/** What the screen shows in place of the ceiling and the percentage when the ceiling is 0 or unset. */
export const NO_CEILING = "No ceiling set";
export const OVER_CEILING = "Over ceiling";

/** A ceiling the percentage can be worked out against: a finite number above 0. */
export function hasCeiling(ceilingUsd: number | null | undefined): ceilingUsd is number {
  return typeof ceilingUsd === "number" && Number.isFinite(ceilingUsd) && ceilingUsd > 0;
}

/** Spend is above a set ceiling. At exactly the ceiling it is not over. */
export function overCeiling(spendUsd: number, ceilingUsd: number | null | undefined): boolean {
  return hasCeiling(ceilingUsd) && Number.isFinite(spendUsd) && spendUsd > ceilingUsd;
}

/** Shortest round-trip decimal, expanded out of scientific notation. 0.09 stays "0.09". */
function plainDecimal(n: number): string {
  const text = n.toString();
  if (!/[eE]/.test(text)) return text;
  const match = text.match(/^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (!match) return text;
  const [, sign, whole, frac = "", expRaw] = match;
  const exp = Number(expRaw);
  const digits = whole + frac;
  const point = whole.length + exp;
  let body: string;
  if (point <= 0) body = "0." + "0".repeat(-point) + digits;
  else if (point >= digits.length) body = digits + "0".repeat(point - digits.length);
  else body = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return sign + body;
}

/** Numerator and power-of-ten scale for the decimal text of a non-negative finite number. */
function rational(n: number): { num: bigint; scale: bigint } {
  const [ints, fracs = ""] = plainDecimal(n).split(".");
  const digits = `${ints}${fracs}`.replace(/^0+(?=\d)/, "") || "0";
  return { num: BigInt(digits), scale: BigInt(10) ** BigInt(fracs.length) };
}

/**
 * Percentage used, as the Usage screen prints it.
 *
 * - No ceiling (0, unset or not a number) is null: the screen shows NO_CEILING and no percentage.
 * - A spend of 0 is "0%".
 * - Any nonzero spend whose true share is under 1% is "<1%". That includes a half such as 0.5%,
 *   which is not rounded up to 1%.
 * - Otherwise the nearest whole number, halves up, with no cap past 100 (120% stays "120%").
 *
 * Halves are decided in integers on the decimal text of each amount. Dividing the IEEE values
 * first turns some exact halves into n.49999999999999, and Math.round then goes the wrong way
 * (0.09 of 0.4 is 22.5, which is 23%, not 22%).
 */
export function percentUsedLabel(spendUsd: number, ceilingUsd: number | null | undefined): string | null {
  if (!hasCeiling(ceilingUsd)) return null;
  if (!(spendUsd > 0) || !Number.isFinite(spendUsd)) return "0%";
  const spend = rational(spendUsd);
  const ceiling = rational(ceilingUsd);
  const zero = BigInt(0);
  const hundred = BigInt(100);
  const twoHundred = BigInt(200);
  const two = BigInt(2);
  if (spend.num === zero || ceiling.num === zero) return "0%";
  // True share under 1%: spend/ceiling < 1/100. Checked before rounding.
  if (spend.num * ceiling.scale * hundred < ceiling.num * spend.scale) return "<1%";
  // floor(spend/ceiling*100 + 1/2).
  const twice = spend.num * ceiling.scale * twoHundred + ceiling.num * spend.scale;
  const den = ceiling.num * spend.scale * two;
  return `${twice / den}%`;
}

/** Whole number for ceiling.percent. 0 when there is no ceiling or the label is "0%" or "<1%"; otherwise the integer in the label. */
export function percentUsedNumber(spendUsd: number, ceilingUsd: number | null | undefined): number {
  const label = percentUsedLabel(spendUsd, ceilingUsd);
  if (label === null || label === "0%" || label === "<1%") return 0;
  return Number(label.slice(0, -1));
}
