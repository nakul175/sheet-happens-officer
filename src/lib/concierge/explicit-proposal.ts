// These two fully specified requests need no model interpretation. Resolve fresh authorized records,
// then use the same proposal builder as tools. A model must not silently omit one requested target.
import type { Actor } from "@/lib/access";
import { buildCard, MAX_CHANGES } from "./changes";
import { findPeople, listProjects, projectTasks } from "./reads";
import type { Stored } from "./types";

const WHO_QUESTION = "Who should I assign it to? Tell me the person's name and I will show you the card to confirm.";
/** Existing missing-person contract, shared by model refusal and the trusted no-op clarification boundary. */
export const whoQuestion = (request: string) => ({
  kind: "choices" as const, text: WHO_QUESTION, choices: [{ id: "none", label: "Never mind" }],
  pending: { request, question: WHO_QUESTION },
});

export type ExplicitRequest = { kind: "complete-open"; project: string } | { kind: "remove-member"; project: string; email: string } | { kind: "clarify-bulk" };
export function explicitRequest(text: string): ExplicitRequest | null {
  const s = text.trim();
  const complete = s.match(/^(?:please\s+)?complete\s+(?:every|all)\s+open\s+tasks?\s+in\s+(.+?)(?:\.\s*There are \d+\.?)?\.?$/i);
  if (complete) return { kind: "complete-open", project: complete[1].trim() };
  const mark = s.match(/^(?:please\s+)?mark\s+(?:every|all)\s+open\s+tasks?\s+in\s+(.+?)\s+(?:as\s+)?(?:done|complete|completed)\.?$/i);
  if (mark) return { kind: "complete-open", project: mark[1].trim() };
  const remove = s.match(/^(?:please\s+)?remove\s+the person with email\s+([^\s<>]+@[^\s<>]+)\s+from\s+(.+?)\.?$/i);
  if (remove) return { kind: "remove-member", email: remove[1].toLowerCase(), project: remove[2].trim() };
  // Quantified write intent that this route cannot fully scope must never fall back to a model subset.
  // The quantifier immediately follows an imperative, so reads and quoted titles such as "All hands" are not intercepted.
  const imperative = /^(?:(?:please|can you|could you|would you|will you)\s+)*(?:complete|finish|close|mark|delete|trash|move|assign|reassign|re-assign|set|change|edit|update|create|add|remove|reopen|block|unblock|send|comment|demote|promote)\s+(?:(?:on|to|for)\s+)?(?:all|every|each|both|[2-9]\d*|1\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty)\b/i;
  if (imperative.test(s)) return { kind: "clarify-bulk" };
  return null;
}
const textReply = (text: string): Stored => ({ kind: "text", text });
export async function explicitProposal(user: Actor, request: string): Promise<Stored | null> {
  const parsed = explicitRequest(request);
  if (!parsed) return null;
  if (parsed.kind === "clarify-bulk" && /^(?:please\s+)?(?:re)?assign\s+(?:all|every|both)\s+of\s+(?:them|those|these)\b/i.test(request.trim())) return whoQuestion(request);
  if (parsed.kind === "clarify-bulk") return textReply("Please name one exact project and the complete set of open tasks to change. I cannot safely narrow a bulk request for you. Nothing changed.");
  const matches = (await listProjects(user, parsed.project)).filter(p => p.name.toLowerCase() === parsed.project.toLowerCase());
  // No fallback to unverified ids or model guesses. Identical visible names must be disambiguated first.
  if (matches.length !== 1) return textReply(matches.length ? "More than one project has that name. Choose the project on screen, or give another identifying detail. Nothing changed." : "I can't find that project. Nothing changed.");
  const project = matches[0];
  let ops: Parameters<typeof buildCard>[1];
  if (parsed.kind === "complete-open") {
    const found = await projectTasks(user, project.id, "open", MAX_CHANGES + 1);
    // Read up to11 plus a truncation flag: no over-limit request can become a10-operation subset card.
    if (found.truncated || found.tasks.length > MAX_CHANGES) return textReply("That request covers more than 10 changes. A card can hold at most 10; please narrow the request. Nothing changed.");
    if (!found.tasks.length) return textReply("There are no open tasks in that project. Nothing changed.");
    ops = found.tasks.map(task => ({ k: "task.complete", taskId: task.id }));
  } else {
    const people = (await findPeople(user, parsed.email, project.id)).filter(p => p.email?.toLowerCase() === parsed.email);
    if (people.length !== 1) return textReply("I can't find that person in that project. Nothing changed.");
    ops = [{ k: "member.remove", projectId: project.id, userId: people[0].id }];
  }
  const built = await buildCard(user, ops);
  return { kind: "card", text: `${built.card.title}. Review it and tap Confirm to apply it.`, card: { id: "", status: "PENDING", ...built.card }, proposal: { ops: built.ops, fingerprint: built.fingerprint, versions: built.versions } };
}
