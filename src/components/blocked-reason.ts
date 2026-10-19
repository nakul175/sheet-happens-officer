/**
 * APL-2644: the blocked-reason box grows with the text.
 * APL-2737 (APL-2555 AC2): it no longer stops at five lines. The reason is at most 300 characters
 * (schemas.ts), so the box grows to show all of it and never scrolls inside.
 */

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
  overflowY: "hidden";
  overflowWrap: "anywhere";
  overscrollBehavior: "contain";
};

export function blockedReasonBox(m: BlockedReasonMetrics): BlockedReasonBox {
  const pad = m.paddingTop + m.paddingBottom;
  const border = m.borderTop + m.borderBottom;
  // scrollHeight excludes the border and can round a single line down. Keep at least one full line.
  const inner = Math.max(m.scrollHeight, m.lineHeight + pad);
  return {
    height: Math.ceil(inner + border),
    overflowY: "hidden",
    overflowWrap: "anywhere",
    overscrollBehavior: "contain",
  };
}

/** Size a blocked-reason field from its current text. Call after mount and on each input. */
export function fitBlockedReason(el: HTMLTextAreaElement): BlockedReasonBox {
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
  return box;
}
