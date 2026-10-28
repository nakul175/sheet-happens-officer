// SHO-2897: the one place a spec resolves the local mail outbox.
//
// Why a function and not a constant: every spec in a Playwright run shares the process environment, so a spec that
// computed `process.env.EMAIL_OUTBOX_DIR ?? ".outbox"` at import time got the same folder as every other spec that did
// the same, and a second one that let the variable fall back to ".outbox" resolved it against its own cwd. Two specs
// then read one folder: mail spec A's server wrote satisfies spec B's assertion, and the gate SHO-2897 guards opens on
// somebody else's mail. The folder the reader uses must be the folder the server was told to write (src/lib/email.ts:63
// reads the same variable), so there is no safe default: a default is a folder this spec does not own.
//
// The fix is to fail loudly, at the point of reading, naming the variable. It is deliberately not thrown at import
// time: a spec that imports a shared helper but never reads mail must still be collectable (vitest.config.mts has no
// setupFiles, and an import-time throw turns a missing variable into wholesale file failures instead of one clear one).
import path from "node:path";

/**
 * The outbox folder this run was told to read, resolved to an absolute path.
 * Throws, naming the variable and the caller, when EMAIL_OUTBOX_DIR is unset or empty.
 */
export function outboxDir(owner: string): string {
  const dir = process.env.EMAIL_OUTBOX_DIR ?? "";
  if (!dir.trim()) {
    throw new Error(
      `${owner}: EMAIL_OUTBOX_DIR is not set. This spec reads the local mail outbox, and there is no default on purpose: ` +
        `".outbox" is a folder every other spec in the run also reads, so spec A's mail would satisfy spec B's assertion. ` +
        `Start the server and the spec with the same EMAIL_OUTBOX_DIR (the folder src/lib/email.ts writes).`,
    );
  }
  return path.resolve(dir);
}
