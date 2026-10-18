/** APL-2644: the blocked-reason box grows with the text up to about five lines, then scrolls inside. */

export const BLOCKED_REASON_MAX_LINES = 5;

export type BlockedReasonMetrics = {
  /** Content height reported by the browser after the field is set to `height: auto`. Excludes the border. */
  scrollHeight: number;
  lineHeight: number;
  paddingTop: number;
  paddingBottom: number;
  borderTop: number;
  borderBottom: number;
};

export type BlockedReasonBox = {
  /** Border-box height, in px. */
  height: number;
  overflowY: "hidden" | "auto";
  overflowWrap: "anywhere";
  overscrollBehavior: "contain";
  /** The text is taller than five lines, so the rest is read by scrolling inside the box. */
  scrolls: boolean;
};

export function blockedReasonBox(m: BlockedReasonMetrics): BlockedReasonBox {
  const pad = m.paddingTop + m.paddingBottom;
  const border = m.borderTop + m.borderBottom;
  const cap = Math.round(m.lineHeight * BLOCKED_REASON_MAX_LINES + pad + border);
  // scrollHeight excludes the border and can round a single line down. Keep at least one full line.
  const inner = Math.max(m.scrollHeight, m.lineHeight + pad);
  const full = Math.ceil(inner + border);
  const scrolls = full > cap;
  return {
    height: scrolls ? cap : full,
    overflowY: scrolls ? "auto" : "hidden",
    overflowWrap: "anywhere",
    overscrollBehavior: "contain",
    scrolls,
  };
}

/** Size a blocked-reason field from its current text. Call after mount and on each input. */
export function fitBlockedReason(el: HTMLTextAreaElement): BlockedReasonBox {
  const top = el.scrollTop;
  el.style.overflowY = "hidden";
  el.style.height = "auto";
  const cs = getComputedStyle(el);
  const parsed = parseFloat(cs.lineHeight);
  const font = parseFloat(cs.fontSize) || 16;
  const box = blockedReasonBox({
    scrollHeight: el.scrollHeight,
    lineHeight: Number.isFinite(parsed) ? parsed : font * 1.4,
    paddingTop: parseFloat(cs.paddingTop) || 0,
    paddingBottom: parseFloat(cs.paddingBottom) || 0,
    borderTop: parseFloat(cs.borderTopWidth) || 0,
    borderBottom: parseFloat(cs.borderBottomWidth) || 0,
  });
  el.style.height = `${box.height}px`;
  el.style.overflowY = box.overflowY;
  el.style.overflowWrap = box.overflowWrap;
  el.style.overscrollBehavior = box.overscrollBehavior;
  if (top) el.scrollTop = top;
  return box;
}
