// SHO-2693 w225: independent review of a9fb9a7 (w215), which restored the claim predicate in front of BOTH reply
// branches (engine.ts:244, `records === 0 || claimsWrite(modelText)`).
//
// A fix of that shape is wrong in two directions and both are asserted here, against a REAL read that returned rows:
//
//   w225/LEGIT-*  the ordinary answer to "which tasks are assigned to me" must still reach the person, byte-exact.
//                 This is the half that protects the product, and it is a requirement, not a nicety.
//   w225/FABRIC-* a sentence that says a write finished, on a turn that wrote nothing, must not be relayed - the
//                 w199 pair AND the phrasings w215's own header claims cannot evade it.
//
// Every case logs the reply and the state after the turn: what the person SEES, and whether anything CHANGED.
//
// Why the LEGIT cases are shaped the way they are. The predicate matched a change verb only where a copula sat
// immediately in front of it (`WAS_DONE`, claims.ts:31), so the passive voice of the DATA - "3 tasks are assigned to
// you", "you were assigned 3 tasks" - reads as a write claim to it, and buildReply then substitutes NOTHING_CHANGED
// for the answer. Those are two of the four shapes this packet names, and they are the rows the read just returned.
import { afterAll, describe, expect, it } from "vitest";
import { account, cleanupZz, task, zzProject, type Account } from "./helpers";
import { actor, db, say, script, tu, useFakeModel } from "./concierge-helpers";
import { sendMessage } from "../src/lib/concierge/engine";
import { claimsWrite } from "../src/lib/concierge/claims";
import type { Message } from "../src/lib/concierge/types";

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}w225`;
let seq = 0;
const leads: Account[] = [];
const projectIds: string[] = [];

afterAll(async () => {
  if (leads.length) await cleanupZz(projectIds, leads);
});

async function fixture() {
  const n = seq++;
  const lead = await account(`ZZ-TEST w225 Lead ${RUN}-${n}`, `nakul17+zz-w225-${RUN}-${n}@aplyd.com`);
  leads.push(lead);
  const projectId = await zzProject(lead, `SHO-2693 w225 ${RUN}-${n}`);
  projectIds.push(projectId);
  const title = `ZZ-TEST ${RUN}-${n} w225-task`;
  const taskId = await task(lead, projectId, { title, assigneeId: lead.id, dueDate: "2031-03-20" });
  return { lead, projectId, taskId, title };
}

const lastAssistant = (messages: Message[]) => [...messages].reverse().find((m) => m.role === "ASSISTANT")!;

/** engine.ts:159, verbatim: the server's own sentence for "wrote nothing, read nothing, claimed something". */
const NOTHING_CHANGED =
  "Nothing has changed. I cannot change anything without a card you confirm, so tell me which task should change and how, and I will show you the card.";

/** Everything a write would leave behind, plus the assignee the claim says changed. */
async function stateOf(lead: Account, projectId: string, taskId: string) {
  const [cards, proposals, results, tasks, row] = await Promise.all([
    db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"card"' } } }),
    db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"proposal"' } } }),
    db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"result"' } } }),
    db.task.count({ where: { projectId } }),
    db.task.findUniqueOrThrow({ where: { id: taskId } }),
  ]);
  return { cards, proposals, results, tasks, assignee: row.assigneeId };
}

/**
 * The ordinary read question, and it keeps the request gate out of the way on purpose: `asksForAssign`
 * (engine.ts:138, /\b(?:re)?assign\b/) does not match "assigned", so what is under test below is the REPLY gate.
 */
const READ_REQUEST = "Which tasks are assigned to me?";


/** Genuine answers to that question. Each one is a fact about rows the read returned, and none claims a change. */
const LEGIT_ANSWERS = [
  "a factual list", "Here are your tasks: three are open, and the oldest is due on Friday.",
  "'assigned' without a change", "3 tasks are assigned to you.",
  "a number and a name", "You have 3 tasks assigned to you, and Sam owns the late one.",
  "past tense about the data", "You were assigned 3 tasks.",
  "a second number-and-name shape", "Your 3 tasks are assigned to you, and Sam is assigned the late one.",
];

/** Sentences that claim a write. On a turn with no card, proposal or result, every one of them is a lie. */
const FABRICATED = [
  "w199 read-then-claim", "my_tasks", "Here are your tasks. I've assigned the late one to Sam and it is done now.",
  "w199 irrelevant-read", "list_projects", "Done - I deleted it for you.",
  "w126 claim", "my_tasks", "Done - I reassigned it for you.",
  "perfect passive", "my_tasks", "It has been reassigned to Sam.",
  "bare participle", "my_tasks", "Reassigned.",
  "participle header", "my_tasks", "Successfully reassigned to Sam.",
  "first person, prefixed verb", "my_tasks", "I have reassigned it to Sam.",
  "first person, un- verb", "my_tasks", "I've unassigned it from Sam and given it to Priya.",
];

describe("w225 SHO-2693: a real read relays the answer, and does not license a write claim", () => {
  useFakeModel();

  for (let i = 0; i < LEGIT_ANSWERS.length; i += 2) {
    const label = LEGIT_ANSWERS[i];
    const answer = LEGIT_ANSWERS[i + 1];
    it(`w225/LEGIT: ${label} - "${answer}" reaches the person`, async () => {
      const { lead, projectId, taskId } = await fixture();
      const before = await stateOf(lead, projectId, taskId);
      script(
        () => [tu("my_tasks", { filter: "all_open" })], // records > 0: the rows the answer is made of
        () => [say(answer)],
      );
      const { messages } = await sendMessage(actor(lead), READ_REQUEST);
      const reply = lastAssistant(messages);
      console.log(
        `w225 LEGIT/${label} -> claimsWrite=${claimsWrite(answer)} kind=${reply.kind} reply=${JSON.stringify(reply.text)} state=${JSON.stringify(await stateOf(lead, projectId, taskId))}`,
      );
      expect(reply.text).toBe(answer); // the answer, not NOTHING_CHANGED
      expect(reply.kind).toBe("answer");
      expect(await stateOf(lead, projectId, taskId)).toEqual(before); // and nothing was written, as it should be
    });
  }

  for (let i = 0; i < FABRICATED.length; i += 3) {
    const label = FABRICATED[i];
    const tool = FABRICATED[i + 1];
    const claim = FABRICATED[i + 2];
    it(`w225/FABRIC: ${label} - the claim is not relayed`, async () => {
      const { lead, projectId, taskId } = await fixture();
      const before = await stateOf(lead, projectId, taskId);
      script(
        () => [tool === "list_projects" ? tu("list_projects", {}) : tu("my_tasks", { filter: "all_open" })],
        () => [say(claim)],
      );
      const { messages } = await sendMessage(actor(lead), tool === "list_projects" ? "Delete the w225-task." : READ_REQUEST);
      const reply = lastAssistant(messages);
      console.log(
        `w225 FABRIC/${label} -> claimsWrite=${claimsWrite(claim)} kind=${reply.kind} reply=${JSON.stringify(reply.text)} state=${JSON.stringify(await stateOf(lead, projectId, taskId))}`,
      );
      expect(await stateOf(lead, projectId, taskId)).toEqual(before); // no card, no proposal, no result, same assignee
      expect(reply.text).not.toContain(claim);
      expect(reply.text).toBe(NOTHING_CHANGED);
    });
  }

  it("w225/DETECTOR: the shapes the predicate still cannot see, asserted so the residual is not a surprise later", () => {
    // A participle used as an object complement: no agent, no perfect, no completion word, no copula.
    for (const missed of ["Consider it reassigned.", "Sam has the late one now.", "I sorted it for you."]) {
      console.log(`w225 DETECTOR ${JSON.stringify(missed)} -> claimsWrite=${claimsWrite(missed)}`);
      expect(claimsWrite(missed)).toBe(false);
    }
    // And the sentence w215's own comment uses as its example of a TRUE statement the blacklist blocks is still
    // blocked: "already" is a completion word, and the fix did not widen the marker frame.
    console.log(`w225 DETECTOR "It is already assigned to Sam." -> claimsWrite=${claimsWrite("It is already assigned to Sam.")}`);
    expect(claimsWrite("It is already assigned to Sam.")).toBe(true);
  });
});
