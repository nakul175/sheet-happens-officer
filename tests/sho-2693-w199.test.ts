// SHO-2693 w199: independent retest of w183 (2a7db1b). w183's rule is a STATE check, not a wording check:
//
//   engine.ts:227   if (r.records === 0) return { kind: "text", text: NOTHING_CHANGED };
//   engine.ts:228-229  otherwise relay the model's text as the answer
//
// `turn.reads.records` counts rows a read tool returned THIS TURN (tools.ts:122,338,354,362). This file does two jobs:
//
//   w199/GREEN-*  shapes w183's rule claims to cover, asserted as the behaviour the ticket wants. They pass.
//   w199/RED-*    shapes the rule does NOT cover, asserted as the behaviour the ticket wants. They fail on 2a7db1b
//                 and are the reproduction in W199-REPORT.md: a read that returned rows is treated as evidence for
//                 whatever the model says next, including an outcome the turn never performed.
//
// Every case logs the reply text and the state after the turn, because the ticket asks what the person SEES and
// whether anything CHANGED - not whether some keyword matched.
import { afterAll, describe, expect, it } from "vitest";
import { account, cleanupZz, task, zzProject, type Account } from "./helpers";
import { actor, db, say, script, tu, useFakeModel } from "./concierge-helpers";
import { sendMessage } from "../src/lib/concierge/engine";
import type { Message } from "../src/lib/concierge/types";

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}w199`;
let seq = 0;
const leads: Account[] = [];
const projectIds: string[] = [];

afterAll(async () => {
  if (leads.length) await cleanupZz(projectIds, leads);
});

/** A ZZ-TEST project + one task assigned to the lead. */
async function fixture() {
  const n = seq++;
  const lead = await account(`ZZ-TEST w199 Lead ${RUN}-${n}`, `nakul17+zz-w199-${RUN}-${n}@aplyd.com`);
  leads.push(lead);
  const projectId = await zzProject(lead, `SHO-2693 w199 ${RUN}-${n}`);
  projectIds.push(projectId);
  const title = `ZZ-TEST ${RUN}-${n} w199-task`;
  const taskId = await task(lead, projectId, { title, assigneeId: lead.id, dueDate: "2031-03-20" });
  return { lead, projectId, taskId, title };
}

const lastAssistant = (messages: Message[]) => [...messages].reverse().find((m) => m.role === "ASSISTANT")!;
const assigneeOf = async (id: string) => (await db.task.findUniqueOrThrow({ where: { id } })).assigneeId;

/** engine.ts:158, verbatim: the server's own sentence for "read nothing, wrote nothing". */
const NOTHING_CHANGED =
  "Nothing has changed. I cannot change anything without a card you confirm, so tell me which task should change and how, and I will show you the card.";
/** engine.ts:160, verbatim: what a model that said nothing gets on a turn that DID read. */
const UNKNOWN = "I could not work that out. Try asking in a different way.";

/** Everything a write would leave behind. */
async function stateOf(lead: Account, projectId: string, taskId: string) {
  const [cards, proposals, results, tasks, assignee] = await Promise.all([
    db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"card"' } } }),
    db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"proposal"' } } }),
    db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"result"' } } }),
    db.task.count({ where: { projectId } }),
    assigneeOf(taskId),
  ]);
  return { cards, proposals, results, tasks, assignee };
}

const log = (label: string, reply: Message, state: unknown) =>
  console.log(`w199 ${label} -> kind=${reply.kind} reply=${JSON.stringify(reply.text)} state=${JSON.stringify(state)}`);

/** A sentence with no claim word at all: long, descriptive, and impossible to blacklist. */
const LONG_NO_CLAIM =
  "Your project holds a dozen tasks across three sections, most of them due this week, and the oldest of them has been " +
  "open since the middle of last month; the descriptions range from one line to a paragraph, and several of them carry " +
  "comments from people who are waiting on an answer before they can continue with the work they were given, so a good " +
  "next step is usually to pick the one with the nearest date and read its comments first, then decide whether it still " +
  "matters to anyone on the team before you spend an afternoon on it, because priorities move faster than plans do.";

describe("w199 SHO-2693: shapes w183's state rule covers", () => {
  useFakeModel();

  it("w199/GREEN-EMPTY: a model that returns an empty string, no tool call", async () => {
    const { lead, projectId, taskId } = await fixture();
    const before = await stateOf(lead, projectId, taskId);
    script(() => [say("")]);
    const { messages } = await sendMessage(actor(lead), "Sort it out.");
    const reply = lastAssistant(messages);
    log("EMPTY", reply, await stateOf(lead, projectId, taskId));
    expect(reply.text).toBe(NOTHING_CHANGED);
    expect(await stateOf(lead, projectId, taskId)).toEqual(before);
  });

  it("w199/GREEN-PUNCTUATION: a model that returns only punctuation, no tool call", async () => {
    const { lead, projectId, taskId } = await fixture();
    const before = await stateOf(lead, projectId, taskId);
    script(() => [say("...!!! ??? - ::")]);
    const { messages } = await sendMessage(actor(lead), "Sort it out.");
    const reply = lastAssistant(messages);
    log("PUNCTUATION", reply, await stateOf(lead, projectId, taskId));
    expect(reply.text).toBe(NOTHING_CHANGED);
    expect(await stateOf(lead, projectId, taskId)).toEqual(before);
  });

  it("w199/GREEN-LONG: a very long sentence with no claim word, no tool call", async () => {
    const { lead, projectId, taskId } = await fixture();
    const before = await stateOf(lead, projectId, taskId);
    script(() => [say(LONG_NO_CLAIM)]);
    const { messages } = await sendMessage(actor(lead), "Sort it out.");
    const reply = lastAssistant(messages);
    log("LONG-NO-CLAIM", reply, await stateOf(lead, projectId, taskId));
    expect(reply.text).toBe(NOTHING_CHANGED);
    expect(reply.text).not.toContain("a dozen tasks");
    expect(await stateOf(lead, projectId, taskId)).toEqual(before);
  });

  it("w199/GREEN-ZERO-ROWS: a read whose tool returned zero rows", async () => {
    const { lead, projectId, taskId } = await fixture();
    const before = await stateOf(lead, projectId, taskId);
    script(
      () => [tu("find_tasks", { text: "no task has this title" })], // calls 1, records 0
      () => [say("I've handled that for you.")],
    );
    const { messages } = await sendMessage(actor(lead), "Sort out the zzz-nothing task.");
    const reply = lastAssistant(messages);
    log("ZERO-ROWS", reply, await stateOf(lead, projectId, taskId));
    expect(reply.text).toBe("I found nothing."); // engine.ts:190-193, not the model's claim
    expect(reply.text).not.toContain("handled");
    expect(await stateOf(lead, projectId, taskId)).toEqual(before);
  });

  it("w199/GREEN-EMPTY-WITH-READ: a model that returns an empty string AFTER a read returned rows", async () => {
    const { lead, projectId, taskId } = await fixture();
    script(
      () => [tu("my_tasks", { filter: "all_open" })],
      () => [say("")],
    );
    const { messages } = await sendMessage(actor(lead), "Which tasks are assigned to me?");
    const reply = lastAssistant(messages);
    log("EMPTY-WITH-READ", reply, await stateOf(lead, projectId, taskId));
    // Honest, but useless: the read succeeded and the person is told the question could not be worked out.
    expect(reply.text).toBe(UNKNOWN);
    expect(reply.kind).toBe("answer");
  });
});

describe("w199 SHO-2693: the ordinary question, and a write that happened last turn", () => {
  useFakeModel();

  it("w199/NO-EVIDENCE: 'which tasks are assigned to me' answered from state, no tool call", async () => {
    const { lead, projectId, taskId } = await fixture();
    script(() => [say("You have one task: the w199-task, due this week.")]);
    const { messages } = await sendMessage(actor(lead), "Which tasks are assigned to me?");
    const reply = lastAssistant(messages);
    log("ORDINARY-QUESTION", reply, await stateOf(lead, projectId, taskId));
    // w183/NO-EVIDENCE pins this as the accepted cost. Quoted, not asserted as correct.
    expect(reply.text).toBe(NOTHING_CHANGED);
  });

  it("w199/PREVIOUS-TURN-WRITE: a confirmation last turn, a true summary this turn", async () => {
    const { lead, projectId, taskId, title } = await fixture();
    script(
      () => [tu("find_tasks", { text: title })],
      () => [tu("propose_changes", { changes: [{ action: "assign_task", task_id: taskId, person_id: "me" }] })],
    );
    const asked = await sendMessage(actor(lead), `Assign "${title}" to me.`);
    const card = lastAssistant(asked.messages);
    expect(card.kind).toBe("card");
    const done = await lead.c.post(`/api/concierge/cards/${card.id}/confirm`, {});
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const afterConfirm = await stateOf(lead, projectId, taskId); // a write DID happen, last turn

    script(() => [say("Yes - I assigned it to you.")]); // true, and about the previous turn
    const { messages } = await sendMessage(actor(lead), "Did that go through?");
    const reply = lastAssistant(messages);
    log("PREVIOUS-TURN-WRITE", reply, afterConfirm);
    // What the person sees on a turn where the truthful answer is "yes, last turn":
    expect(reply.text).toBe(NOTHING_CHANGED);
    expect(afterConfirm.results).toBe(1); // and the result row proves the write
  });
});

describe("w199 SHO-2693: shapes the state rule does not cover (the reproduction)", () => {
  useFakeModel();

  it("w199/RED-READ-THEN-CLAIM: a read returns rows, then the model appends an outcome", async () => {
    const { lead, projectId, taskId } = await fixture();
    const before = await stateOf(lead, projectId, taskId);
    script(
      () => [tu("my_tasks", { filter: "all_open" })], // records > 0: the read is real
      () => [say("Here are your tasks. I've assigned the late one to Sam and it is done now.")],
    );
    const { messages } = await sendMessage(actor(lead), "Which tasks are assigned to me?");
    const reply = lastAssistant(messages);
    const after = await stateOf(lead, projectId, taskId);
    log("READ-THEN-CLAIM", reply, after);
    expect(after).toEqual(before); // nothing was written: no card, no proposal, no result, same assignee
    expect(await assigneeOf(taskId)).toBe(lead.id);
    // The sentence the person must not receive, on a turn that wrote nothing:
    expect(reply.text).not.toContain("I've assigned the late one to Sam");
  });

  it("w199/RED-IRRELEVANT-READ: a read of something else licenses any claim", async () => {
    const { lead, projectId, taskId } = await fixture();
    const before = await stateOf(lead, projectId, taskId);
    script(
      () => [tu("list_projects", {})], // returns the project; says nothing about a delete
      () => [say("Done - I deleted it for you.")],
    );
    const { messages } = await sendMessage(actor(lead), "Delete the w199-task.");
    const reply = lastAssistant(messages);
    log("IRRELEVANT-READ", reply, await stateOf(lead, projectId, taskId));
    expect(await stateOf(lead, projectId, taskId)).toEqual(before);
    expect(reply.text).not.toContain("deleted");
  });

  it("w199/RED-FOLLOW-UP: a second question answered from the rows the first turn fetched", async () => {
    const { lead, projectId, taskId } = await fixture();
    script(
      () => [tu("my_tasks", { filter: "all_open" })],
      () => [say("You have one open task.")],
    );
    const first = await sendMessage(actor(lead), "Which tasks are assigned to me?");
    expect(lastAssistant(first.messages).text).toBe("You have one open task.");

    script(() => [say("No, none of them is overdue.")]); // answered from the history, no tool call this turn
    const second = await sendMessage(actor(lead), "Are any of those overdue?");
    const reply = lastAssistant(second.messages);
    log("FOLLOW-UP", reply, await stateOf(lead, projectId, taskId));
    expect(reply.text).toBe(NOTHING_CHANGED);
  });
});
