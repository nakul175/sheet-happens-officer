"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import { attachTaskSheetBack } from "@/lib/task-sheet-history";
import { closeDialog, topDialog } from "@/components/ui";

const useCommitEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
export function useTaskSheetBack(options: { id: string; enabled: boolean; root: () => HTMLElement | null; blocked: () => boolean; beforePrompt: () => void; prompt: () => void }) {
  const latest = useRef(options);
  const controller = useRef<ReturnType<typeof attachTaskSheetBack> | null>(null);
  useCommitEffect(() => { latest.current = options; });
  useCommitEffect(() => {
    if (!options.enabled) return;
    const back = attachTaskSheetBack({ id: options.id, blocked: () => latest.current.blocked(), beforePrompt: () => latest.current.beforePrompt(), prompt: () => latest.current.prompt(),
      nestedClose: () => {
        const top = topDialog();
        return top && top !== latest.current.root() ? () => closeDialog(top) : null;
      },
    });
    controller.current = back;
    return () => { back.detach(); controller.current = null; };
  }, [options.id, options.enabled]);
  return () => controller.current?.close() ?? false;
}
