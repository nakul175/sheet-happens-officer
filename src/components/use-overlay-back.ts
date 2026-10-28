"use client";
import { useCallback, useEffect, useId, useLayoutEffect, useRef } from "react";
import { attachOverlayBack } from "@/lib/overlay-history";
import { closeDialog, topDialog } from "@/components/ui";
const useCommitEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Dismiss first, then run a selection/navigation callback after the same-URL entry has been consumed. */
export function useOverlayBack(open: boolean, onClose: () => void, root: () => HTMLElement | null) {
  const id = useId(), latest = useRef({ onClose, root });
  const controller = useRef<ReturnType<typeof attachOverlayBack> | null>(null);
  useCommitEffect(() => { latest.current = { onClose, root }; });
  useCommitEffect(() => {
    if (!open) return;
    const control = attachOverlayBack(id, () => latest.current.onClose(), () => {
      const top = topDialog(), own = latest.current.root();
      return top && top !== own ? () => closeDialog(top) : null;
    });
    controller.current = control;
    return () => { control.detach(); controller.current = null; };
  }, [open, id]);
  return useCallback((after?: () => void) => { if (controller.current) controller.current.close(after); else { latest.current.onClose(); after?.(); } }, []);
}
