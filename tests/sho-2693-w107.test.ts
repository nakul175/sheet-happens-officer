// SHO-2693 re-disposition (w107): the tool-less branch of the "nobody named" request.
//
// The five-case gate (tests/sho-2693-w90.test.ts) covers two ways to reach the server's who question: the request
// keyword (`/\bassign\b/`) and a refused person-less proposal (`turn.needsWho`). Its fifth case, w90/RESIDUAL, pins the
// third way a model can answer - prose, no tool call - as "the model's own words stand", i.e. it passes *because* the
// branch bypasses the refusal. This file asks the question that leaves open: when the wording names nobody and the
// model calls no tool, does the request that changes an assignee come back as a question, and is any state written?
//
//   w107/AC1-AC2            "Assign <task>." with no person, tool-less: question, no card, no proposal, assignee unchanged
//   w107/TOOL-LESS-REASSIGN "Reassign it." with no person, tool-less: the same reply (red at this head)
//   w107/CARD-WINS          "Reassign it to me." *with* a proposal: the card wins over the wording (guard on the fix)
import { afterAll, describe, expect, it } from "vitest";
import { account, cleanupZz, task, zzProject, type Account } from "./helpers";
import { actor, db, say, script, tu, useFakeModel } from "./concierge-helpers";
import { sendMessage } from "../src/lib/concierge/engine";
import type { Message } from "../src/lib/concierge/types";

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}w107`;
let seq = 0;
const leads: Account[] = [];
const projectIds: string[] = [];

afterAll(async () => {
  if (leads.length) await cleanupZz(projectIds, leads);
});

/** A ZZ-TEST task assigned to the lead: "assigned to somebody else" is the fixture's meaning, the app never stores none. */
async function fixture() {
  const n = seq++;
  const lead = await account(`ZZ-TEST w107 Lead ${RUN}-${n}`, `nakul17+zz-w107-${RUN}-${n}@aplyd.com`);
  leads.push(lead);
  const projectId = await zzProject(lead, `SHO-2693 w107 ${RUN}-${n}`);
  projectIds.push(projectId);
  const title = `ZZ-TEST ${RUN}-${n} unassigned-ask`;
  const taskId = await task(lead, projectId, { title, assigneeId: lead.id, dueDate: "2031-03-20" });
  return { lead, projectId, taskId, title };
}

const lastAssistant = (messages: Message[]) => [...messages].reverse().find((m) => m.role === "ASSISTANT")!;
const assigneeOf = async (id: string) => (await db.task.findUniqueOrThrow({ where: { id } })).assigneeId;

/** The state a refused turn must leave behind, counted rather than described. */
async function stateOf(lead: Account, projectId: string) {
  const [cards, proposals, results, tasks] = await Promise.all([
    db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"card"' } } }),
    db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"proposal"' } } }),
    db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"result"' } } }),
    db.task.count({ where: { projectId } }),
  ]);
  return { cards, proposals, results, tasks };
}

describe("w107 SHO-2693: the tool-less 'reassign' branch", () => {
  useFakeModel();

  it("w107/AC1-AC2: 'Assign <task>.' with no person and no tool call asks who and writes nothing", async () => {
    const { lead, projectId, taskId, title } = await fixture();
    const before = await stateOf(lead, projectId);
    expect(before).toEqual({ cards: 0, proposals: 0, results: 0, tasks: 1 }); // the fixture's own task, and nothing else
    script(() => [say("Who should I assign it to?")]);
    const asked = await sendMessage(actor(lead), `Assign "${title}".`);
    expect(asked.messages.at(0)!.role).toBe("USER");
    const reply = lastAssistant(asked.messages);
    expect(reply.kind).toBe("choices");
    expect(reply.text).toMatch(/Who should I assign it to/);
    expect(await stateOf(lead, projectId)).toEqual(before);
    expect(await assigneeOf(taskId)).toBe(lead.id);
  });

  it("w107/TOOL-LESS-REASSIGN: 'Reassign it.' with no person and no tool call asks who and writes nothing", async () => {
    // The wording the keyword gate misses: "reassign" has no word boundary before "assign". Nothing is written on
    // either side, so AC2 is safe by construction; AC1 - "comes back as a question asking to whom" - is not, unless
    // the server asks. A model that answers "Done, reassigned." here tells the person a write happened that did not.
    const { lead, projectId, taskId } = await fixture();
    const before = await stateOf(lead, projectId);
    script(() => [say("Done - I reassigned it for you.")]);
    const { messages } = await sendMessage(actor(lead), "Reassign it.");
    const reply = lastAssistant(messages);
    expect(reply.text).toMatch(/Who should I assign it to/);
    expect(reply.text).not.toBe("Done - I reassigned it for you.");
    expect(await stateOf(lead, projectId)).toEqual(before);
    expect(await assigneeOf(taskId)).toBe(lead.id);
  });

  it("w107/CARD-WINS: 'Reassign it to me.' with a proposal is still the card, not the who question", async () => {
    // The guard on any widening of the wording gate: a card built this turn returns before the question, so a request
    // that named its person and produced a proposal keeps its card.
    const { lead, taskId, title } = await fixture();
    script(
      () => [tu("find_tasks", { text: title })],
      () => [tu("propose_changes", { changes: [{ action: "assign_task", task_id: taskId, person_id: "me" }] })],
    );
    const { messages } = await sendMessage(actor(lead), "Reassign it to me.");
    const reply = lastAssistant(messages);
    expect(reply.kind).toBe("card");
    expect(await assigneeOf(taskId)).toBe(lead.id); // the card is PENDING: reading it does not apply it
  });
});
