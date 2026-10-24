import type { TaskRec } from "@/lib/concierge/reads";
import type { Turn } from "@/lib/concierge/tools";

/** Deliberately narrow read grammar. The entire project suffix must be the fetched project's name;
 * quoted instructions, extra commands, plural/bulk reads and ordinary write requests never qualify. */
export function exactTitleRead(request: string, turn: Pick<Turn, "reads" | "seen" | "ops" | "needsWho">): TaskRec | null {
  if (!turn.reads.calls || !turn.reads.records || turn.ops.length || turn.needsWho || turn.seen.tasks.size !== 1) return null;
  const task = [...turn.seen.tasks.values()][0];
  if (task.done) return null;
  const match = /^What is the exact title of the open task in (.+)\?$/i.exec(request.trim());
  if (!match) return null;
  const normalized = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return normalized(match[1]) === normalized(task.project) ? task : null;
}
