// SHO-2693 independent disposition (w90): the four claims a reviewer of 282e31d has to decide for itself.
//
// 282e31d is not about the "assign" word boundary, whatever the packet says: it puts a real `pending` on the who
// question (B2) and lets the refusal, `turn.needsWho`, decide the reply as well as the request keyword (B3).
// These cases are written against the shapes those two hunks touch and nothing else, so the same file can be run on
// 208a279 (without the commit) and on 208a279 + 282e31d (with it):
//
//   w90/B2       the who question's one option works through the real route            (red before, green after)
//   w90/B3       a person-less refusal asks who even when the wording says "reassign"   (red before, green after)
//   w90/B1       an "assigned" read question keeps the model's answer                  (green both: already fixed)
//   w90/WIDENING any required-person refusal now asks the assign-worded question        (red before, green after)
//
// The last one is a characterisation, not an AC: it says out loud what the new gate catches that the keyword did not.
import { afterAll, describe, expect, it } from "vitest";
import { account, cleanupZz, task, zzProject, type Account } from "./helpers";
import { actor, db, say, script, tu, useFakeModel } from "./concierge-helpers";
import { sendMessage } from "../src/lib/concierge/engine";
import { thread } from "../src/lib/concierge/thread";
import { choicesActive } from "../src/components/concierge/logic";
import type { Message } from "../src/lib/concierge/types";

const RUN = `${Date.now().toString(36)}w90`;
let seq = 0;
const leads: Account[] = [];
const projectIds: string[] = [];

afterAll(async () => {
  if (leads.length) await cleanupZz(projectIds, leads);
});

/** A ZZ-TEST task assigned to the lead, so "not assigned to the person the request names" is the fixture's meaning. */
async function unassigned() {
  const n = seq++;
  const lead = await account(`ZZ-TEST w90 Lead ${RUN}-${n}`, `nakul17+zz-w90-${RUN}-${n}@aplyd.com`);
  leads.push(lead);
  const projectId = await zzProject(lead, `SHO-2693 w90 ${RUN}-${n}`);
  projectIds.push(projectId);
  const title = `ZZ-TEST ${RUN}-${n} w90-unassigned`;
  const taskId = await task(lead, projectId, { title, assigneeId: lead.id });
  return { lead, taskId, title };
}

const lastAssistant = (messages: Message[]) => [...messages].reverse().find((m) => m.role === "ASSISTANT")!;
const assigneeOf = async (id: string) => (await db.task.findUniqueOrThrow({ where: { id } })).assigneeId;
const storedOf = async (id: string) => JSON.parse((await db.chatMessage.findUniqueOrThrow({ where: { id } })).content) as {
  kind: string; choices?: { id: string }[]; pending?: unknown; choiceAnswered?: string;
};

/** propose_changes naming no person. The task id is remembered from the find step, because the next tool result is people. */
const plansWithoutPerson = (taskId: string, action = "assign_task") =>
  (): ReturnType<typeof tu>[] => [tu("propose_changes", { changes: [{ action, task_id: taskId }] })];

describe("w90 SHO-2693 disposition of 282e31d", () => {
  useFakeModel();

  it("w90/B2: the who question's Never mind option is answerable through the real route", async () => {
    const { lead, taskId, title } = await unassigned();
    script(() => [say("Who?")]);
    const asked = await sendMessage(actor(lead), `Assign "${title}".`);
    const reply = lastAssistant(asked.messages);
    expect(reply.kind).toBe("choices");
    const rows = await thread(actor(lead));
    expect(choicesActive(rows, rows[rows.length - 1])).toBe(true);
    // Tapping the only option goes through the real route, which is the path the browser takes.
    const tapped = await lead.c.post(`/api/concierge/choices/${reply.id}`, { choiceId: "none" });
    expect(tapped.status, JSON.stringify(tapped.json)).toBe(200);
    expect(tapped.json.messages.at(-1).text).toBe("Okay, I dropped that request. Nothing was changed.");
    // ...because the message stores a pending, which is what answerChoice's guard reads.
    expect((await storedOf(reply.id)).pending).toBeDefined();
    expect((await storedOf(reply.id)).choiceAnswered).toBe("none");
    expect(await assigneeOf(taskId)).toBe(lead.id);
  });

  it("w90/B3: a person-less refusal asks who even when the wording says reassign", async () => {
    const { lead, taskId, title } = await unassigned();
    script(
      () => [tu("find_tasks", { text: title })],
      plansWithoutPerson(taskId),
      () => [say("I need a person for that.")],
    );
    const { messages } = await sendMessage(actor(lead), "Reassign everything to me.");
    const reply = lastAssistant(messages);
    expect(reply.kind).toBe("choices");
    expect(reply.text).toMatch(/Who should I assign it to/);
    expect(reply.text).not.toBe("I need a person for that.");
    expect(await assigneeOf(taskId)).toBe(lead.id);
  });

  it("w90/B1: a read question containing 'assigned' keeps the model's answer", async () => {
    const { lead } = await unassigned();
    script(() => [say("Here are the tasks assigned to you.")]);
    const { messages } = await sendMessage(actor(lead), "Which tasks are assigned to me?");
    const reply = lastAssistant(messages);
    expect(reply.kind).toBe("text");
    expect(reply.text).toBe("Here are the tasks assigned to you.");
  });

  it("w90/WIDENING: a person-less collaborator refusal now asks the assign-worded question", async () => {
    const { lead, taskId, title } = await unassigned();
    script(
      () => [tu("find_tasks", { text: title })],
      plansWithoutPerson(taskId, "add_collaborator"),
      () => [say("Who should be added?")],
    );
    // Deliberately contains no "assign": only the refusal can decide this reply.
    const { messages } = await sendMessage(actor(lead), `Add someone to "${title}".`);
    const reply = lastAssistant(messages);
    expect(reply.kind).toBe("choices");
    // ...and the sentence is assign-specific even though the missing person is a collaborator: recorded, not endorsed.
    expect(reply.text).toMatch(/Who should I assign it to/);
  });

  it("w90/RESIDUAL: 'reassign' with no tool call asks who instead of trusting the model's words", async () => {
    // At 282e31d this case pinned the opposite: kind "text" carrying the model's own sentence, because the gate's new
    // half is `turn.needsWho`, which only runTool sets, and the keyword half was `/\bassign\b/`, which "reassign" misses.
    // SHO-2693 w107 widened the keyword to `/\b(?:re)?assign\b/` (engine.ts:130): a tool-less "Reassign it." now gets
    // the server's question, as the AC asks. Nothing was written before or after - AC2 was never at risk.
    const { lead } = await unassigned();
    script(() => [say("I need a name first.")]);
    const { messages } = await sendMessage(actor(lead), "Reassign all of them to me.");
    const reply = lastAssistant(messages);
    expect(reply.kind).toBe("choices");
    expect(reply.text).toMatch(/Who should I assign it to/);
  });
});
