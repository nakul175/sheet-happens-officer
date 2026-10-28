// SHO-2693 (APL-2513 AC2): "Assign <task>" with no person must come back as a question asking to whom, and nothing
// may happen until a person is named.
// The failure was in the reply routing, not in the model: runTool threw away a proposal refused for naming no person,
// and buildReply then fell through to the model's own words. When the model answered without calling any tool (its
// normal habit for a question), that fell to a top-level kind "text" — and when a find tool had run first, kind
// "answer" — so APL-2513's `kind === "text" || kind === "choices"` was false even though a human reading it saw a
// question. These tests drive the real turn code (sendMessage -> runTool -> buildReply) with a scripted model, which
// is the only part a missing provider cannot prove; see BUG-2693.md.
import { afterAll, describe, expect, it } from "vitest";
import { account, cleanupZz, task, zzProject, type Account } from "./helpers";
import { actor, db, lastData, say, script, tu, useFakeModel } from "./concierge-helpers";
import { sendMessage } from "../src/lib/concierge/engine";
import { confirmCard } from "../src/lib/concierge/cards";
import { choicesActive } from "../src/components/concierge/logic";
import { thread } from "../src/lib/concierge/thread";
import type { Message } from "../src/lib/concierge/types";

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
let seq = 0;
const leads: Account[] = [];
const projectIds: string[] = [];

afterAll(async () => {
  if (leads.length) await cleanupZz(projectIds, leads);
});

/** A ZZ-TEST task that nobody is assigned to, plus a colleague to name later. */
async function unassigned() {
  const n = seq++;
  const lead = await account(`ZZ-TEST Lead 2693 ${RUN}-${n}`, `nakul17+zz-2693-${RUN}-${n}@aplyd.com`);
  leads.push(lead);
  const member = await account(`ZZ-TEST Member 2693 ${RUN}-${n}`, `nakul17+zz-2693m-${RUN}-${n}@aplyd.com`);
  leads.push(member);
  const projectId = await zzProject(lead, `SHO-2693 ${RUN}-${n}`);
  projectIds.push(projectId);
  const added = await lead.c.post(`/api/projects/${projectId}/members`, { userId: member.id, role: "EDITOR" });
  expect(added.status, JSON.stringify(added.json)).toBe(201);
  const title = `ZZ-TEST ${RUN}-${n} unassigned-ask`;
  // The app never stores a task with no assignee: an omitted one falls to the project leader (src/lib/tasks.ts:150).
  // "Unassigned" here means "not assigned to the person the request will name".
  const taskId = await task(lead, projectId, { title, assigneeId: lead.id });
  return { lead, member, taskId, title };
}

const lastAssistant = (messages: Message[]) => [...messages].reverse().find((m) => m.role === "ASSISTANT")!;
const assigneeOf = async (id: string) => (await db.task.findUniqueOrThrow({ where: { id } })).assigneeId;
const isQuestion = (m: Message) => (m.kind === "text" || m.kind === "choices") && m.text.trim().length > 0;
const storedOf = async (id: string) => JSON.parse((await db.chatMessage.findUniqueOrThrow({ where: { id } })).content) as { kind: string; card?: unknown; proposal?: unknown; result?: unknown; choiceAnswered?: string };

/**
 * The chain a real model follows for "Assign <task>" with no person: find the task with a tool, then propose it to
 * nobody. The task id is remembered from the find step, because the next tool result holds only the people.
 */
function plansWithoutPerson(taskId: string) {
  return (): ReturnType<typeof tu>[] => [tu("propose_changes", { changes: [{ action: "assign_task", task_id: taskId }] })];
}
/** Same chain when the model names a person it found this turn. */
function plansToPerson(taskId: string, personId: string) {
  return (): ReturnType<typeof tu>[] => [tu("propose_changes", { changes: [{ action: "assign_task", task_id: taskId, person_id: personId }] })];
}

describe("qa:TC missing SHO-2693 assign without a person asks who and changes nothing", () => {
  useFakeModel();

  it("qa:TC missing AC1: the model's own words are replaced by the server's question, as kind choices", async () => {
    const { lead, taskId, title } = await unassigned();
    // The model behaves like a real one that understood the rule: it answers without calling any tool. That used to
    // leave a top-level kind "text", which APL-2513's assertion does not accept.
    script(() => [say("Who should I assign it to?")]);
    const { messages } = await sendMessage(actor(lead), `Assign "${title}".`);
    const reply = lastAssistant(messages);
    expect(reply.kind).toBe("choices");
    expect(reply.text).toMatch(/who/i);
    expect(reply.card).toBeUndefined();
    expect(await assigneeOf(taskId)).toBe(lead.id);
  });

  it("qa:TC missing AC1: a proposal with no person_id comes back as a question, not a card and not a plain answer", async () => {
    const { lead, taskId, title } = await unassigned();
    script(() => [tu("find_tasks", { text: title })], plansWithoutPerson(taskId), () => [say("Which person?")]);
    const { messages } = await sendMessage(actor(lead), `Assign "${title}".`);
    const reply = lastAssistant(messages);
    expect(reply.kind).toBe("choices");
    expect(reply.text).toMatch(/who/i);
    expect(reply.card).toBeUndefined();
  });

  it("qa:TC missing AC2: no card and no proposal is stored, and the assignee is unchanged", async () => {
    const { lead, member, taskId, title } = await unassigned();
    const before = await assigneeOf(taskId);
    script(() => [tu("find_tasks", { text: title })], plansWithoutPerson(taskId), () => [say("Which person?")]);
    const { messages } = await sendMessage(actor(lead), `Assign "${title}".`);
    const rows = await db.chatMessage.findMany({ where: { userId: lead.id }, orderBy: { createdAt: "asc" } });
    const stored = rows.map((row) => JSON.parse(row.content) as { kind: string; card?: unknown; proposal?: unknown; result?: unknown });
    expect(stored.filter((s) => s.kind === "card")).toEqual([]);
    expect(stored.filter((s) => s.card || s.proposal || s.result)).toEqual([]);
    expect(messages.some((m) => m.card)).toBe(false);
    expect(await assigneeOf(taskId)).toBe(before);
    expect(await assigneeOf(taskId)).not.toBe(member.id);
  });

  it("qa:TC missing AC3: naming the person still produces the confirm card, and does not assign yet", async () => {
    const { lead, member, taskId, title } = await unassigned();
    script(
      () => [tu("find_tasks", { text: title })],
      () => [tu("find_people", { text: member.name })],
      (r) => plansToPerson(taskId, lastData(r).people[0].id)(),
    );
    const { messages } = await sendMessage(actor(lead), `Assign "${title}" to ${member.name}.`);
    const reply = lastAssistant(messages);
    expect(reply.kind).toBe("card");
    expect(reply.card).toBeDefined();
    expect(reply.card!.status).toBe("PENDING");
    // A card is not a change: the person is still not assigned until the card is confirmed.
    expect(await assigneeOf(taskId)).not.toBe(member.id);
  });

  it("qa:TC missing AC3: a confirmed card is applied, so the who question does not replace a real card", async () => {
    const { lead, member, taskId, title } = await unassigned();
    script(
      () => [tu("find_tasks", { text: title })],
      () => [tu("find_people", { text: member.name })],
      (r) => plansToPerson(taskId, lastData(r).people[0].id)(),
    );
    const { messages } = await sendMessage(actor(lead), `Assign "${title}" to ${member.name}.`);
    const card = messages.find((m) => m.kind === "card")!;
    expect(card).toBeDefined();
    expect(card.text).not.toMatch(/Who should I assign it to/);
    await confirmCard(actor(lead), card.id);
    expect(await assigneeOf(taskId)).toBe(member.id);
  });

  it("qa:TC missing AC3: the who question is stored and shown, and the person can still name who next", async () => {
    const { lead, member, taskId, title } = await unassigned();
    script(() => [say("Who?")]);
    const asked = await sendMessage(actor(lead), `Assign "${title}".`);
    const reply = lastAssistant(asked.messages);
    const stored = await storedOf(reply.id);
    expect(stored.kind).toBe("choices");
    expect(reply.choices).toEqual([{ id: "none", label: "Never mind" }]);
    const rows = await thread(actor(lead));
    expect(rows[rows.length - 1].id).toBe(reply.id);
    expect(isQuestion(rows[rows.length - 1])).toBe(true);
    // Naming the person next is not blocked by the unanswered question: a new message drops it (SHO-US-8.4 AC6).
    script(
      () => [tu("find_tasks", { text: title })],
      () => [tu("find_people", { text: member.name })],
      (r) => plansToPerson(taskId, lastData(r).people[0].id)(),
    );
    const second = await sendMessage(actor(lead), `${member.name}`);
    expect(lastAssistant(second.messages).kind).toBe("card");
    // Still nothing applied: only the person's Confirm can do that.
    expect(await assigneeOf(taskId)).not.toBe(member.id);
  });

  // The who-question is triggered by the request's wording (engine.ts asksForAssign). It must match the word "assign"
  // and not the prefix of "assigned": a read-only question used to be answered with "Who should I assign it to?" and the
  // model's real answer was thrown away (SHO-2693 re-verification, w52).
  it("qa:TC missing AC3: a question about assignments keeps its answer instead of asking who to assign", async () => {
    const { lead, title } = await unassigned();
    script(() => [tu("find_tasks", { text: title })], () => [say(`You have one task: ${title}`)]);
    const read = await sendMessage(actor(lead), "Which tasks are assigned to me?");
    const reply = lastAssistant(read.messages);
    expect(reply.kind).toBe("answer");
    expect(reply.text).not.toMatch(/Who should I assign it to/);
    expect(reply.text).toContain(title);
    // The same turn, when it does ask to assign, is still the server's question.
    script(() => [say("ok")]);
    const asked = await sendMessage(actor(lead), "please assign it to somebody");
    expect(lastAssistant(asked.messages).kind).toBe("choices");
    expect(isQuestion(lastAssistant(asked.messages))).toBe(true);
  });

  // SHO-2693 independent re-review (w70), blocker B2: the who question's one option has to work. The browser renders
  // a `choices` message with a button per option and enables it while it is the newest, unanswered message
  // (src/components/concierge/logic.ts choicesActive, src/components/concierge/MessageView.tsx), and tapping it POSTs to
  // /api/concierge/choices/[messageId]. answerChoice refuses any choices message without `pending`
  // (src/lib/concierge/engine.ts: `s.kind !== "choices" || !s.pending` -> 404 "Message not found"), so a who question
  // that carries no `pending` offers one dead button and leaves the person in an error state.
  it("qa:TC missing AC1: the who question's Never mind option is answerable and drops the request", async () => {
    const { lead, taskId, title } = await unassigned();
    script(() => [say("Who?")]);
    const asked = await sendMessage(actor(lead), `Assign "${title}".`);
    const reply = lastAssistant(asked.messages);
    expect(reply.kind).toBe("choices");
    // Exactly what the thread shows the person: one enabled button, because this is the newest unanswered message.
    const rows = await thread(actor(lead));
    expect(choicesActive(rows, rows[rows.length - 1])).toBe(true);
    // ...and tapping it goes through the real route, not around it.
    const tapped = await lead.c.post(`/api/concierge/choices/${reply.id}`, { choiceId: "none" });
    expect(tapped.status, JSON.stringify(tapped.json)).toBe(200);
    expect(tapped.json.messages.at(-1).text).toBe("Okay, I dropped that request. Nothing was changed.");
    expect((await storedOf(reply.id)).choiceAnswered).toBe("none");
    // Nothing was assigned: the dropped request stayed dropped.
    expect(await assigneeOf(taskId)).toBe(lead.id);
  });

  // SHO-2693 independent re-review (w70), blocker B3: the refusal's own signal has to decide the reply too, or the
  // keyword is the only gate and a real assign request is missed. "Reassign everything to me" asks to assign and names
  // nobody, but /\bassign\b/ does not match inside "reassign"; only turn.needsWho — set by runTool when a proposal is
  // refused for naming no person — knows a person is owed. Before this, that turn fell through to the model's own
  // words, which is the same defect AC1 measured on the parent.
  it("qa:TC missing AC1: a refusal for naming nobody asks who even when the wording says reassign", async () => {
    const { lead, taskId, title } = await unassigned();
    script(
      () => [tu("find_tasks", { text: title })],
      () => plansWithoutPerson(taskId)(),
      () => [say("I need a person for that.")],
    );
    const { messages } = await sendMessage(actor(lead), "Reassign everything to me.");
    const reply = lastAssistant(messages);
    expect(reply.kind).toBe("choices");
    expect(reply.text).toMatch(/Who should I assign it to/);
    // The model's own sentence is not what the person is shown, and nothing moved.
    expect(reply.text).not.toBe("I need a person for that.");
    expect(await assigneeOf(taskId)).toBe(lead.id);
  });
});
