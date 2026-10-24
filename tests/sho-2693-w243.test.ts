// SHO-2693 w243: the regression W225 named does NOT reproduce at this HEAD (d7ea3ac carries W225's 55235cb), so this
// file does the two jobs that were still open: it pins the WHOLE matrix in one place, and it proves the verdict on the
// two boundary shapes is produced by the distinction, not by a word list.
//
// The distinction the predicate has to make, in words:
//
//   DATA    a sentence that describes the state of the rows the read returned, attributed to the asker's own record:
//           "3 tasks are assigned to you", "you were assigned 3 tasks", "Sam is assigned the late one". Simple aspect
//           (is/are/was/were + participle) with the recipient being the asker - or nobody - is a description of a
//           state, and rows are exactly what establish state. Relayed.
//   ACTION  a sentence that says the world changed during THIS turn: an agent (I/we) performed it, or the perfect
//           aspect presents a state as the result of a completed act ("has been reassigned"), or a row was handed to a
//           third party ("assigned to Sam"), or the sentence is an OUTCOME with no verb at all ("It's done."). The turn
//           wrote nothing (engine.ts:244 is reached only with no card, proposal or result), so every one of those is a
//           lie. Refused, with the server's own NOTHING_CHANGED.
//
// Why the boundary rows below are the proof that this is not a wider word list. Both rows use the *same* vocabulary
// question in opposite directions: the honest row contains a change verb ("assigned") and is relayed, the claim row
// contains no change verb at all ("It's done.") and is refused. A detector that keys on the verb - which is what
// w107/w126/w148/w164 shipped - gets both of them wrong; the inversion is asserted, not asserted-about.
import { afterAll, describe, expect, it } from "vitest";
import { account, cleanupZz, task, zzProject, type Account } from "./helpers";
import { actor, db, say, script, tu, useFakeModel } from "./concierge-helpers";
import { sendMessage } from "../src/lib/concierge/engine";
import { claimsWrite } from "../src/lib/concierge/claims";
import type { Message } from "../src/lib/concierge/types";

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}w243`;
let seq = 0;
const leads: Account[] = [];
const projectIds: string[] = [];

afterAll(async () => {
  if (leads.length) await cleanupZz(projectIds, leads);
});

async function fixture() {
  const n = seq++;
  const lead = await account(`ZZ-TEST w243 Lead ${RUN}-${n}`, `nakul17+zz-w243-${RUN}-${n}@aplyd.com`);
  leads.push(lead);
  const projectId = await zzProject(lead, `SHO-2693 w243 ${RUN}-${n}`);
  projectIds.push(projectId);
  const title = `ZZ-TEST ${RUN}-${n} w243-task`;
  const taskId = await task(lead, projectId, { title, assigneeId: lead.id });
  return { lead, projectId, taskId, title };
}

const lastAssistant = (messages: Message[]) => [...messages].reverse().find((m) => m.role === "ASSISTANT")!;

/** engine.ts:159, verbatim: the server's own sentence for "wrote nothing, read nothing, claimed something". */
const NOTHING_CHANGED =
  "Nothing has changed. I cannot change anything without a card you confirm, so tell me which task should change and how, and I will show you the card.";

/** engine.ts:138, verbatim: a read question whose "assigned" keeps the request gate out of the way. */
const READ_REQUEST = "Which tasks are assigned to me?";

/** Everything a write would leave behind, plus the assignee a claim would have moved. */
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
 * The four DATA shapes W225 requires, plus the two other genuine answers earlier packets relayed (w215's
 * RELAY-GENUINE-READ, w90's B1). Every one describes rows the read returned, and every one must reach the person.
 */
const DATA_SHAPES: [string, string][] = [
  ["w225/LEGIT factual list", "Here are your tasks: three are open, and the oldest is due on Friday."],
  ["w225/LEGIT 'assigned' with no change", "3 tasks are assigned to you."],
  ["w225/LEGIT number and a name", "You have 3 tasks assigned to you, and Sam owns the late one."],
  ["w225/LEGIT past tense about the data", "You were assigned 3 tasks."],
  ["w225/LEGIT second number-and-name shape", "Your 3 tasks are assigned to you, and Sam is assigned the late one."],
  ["w215/RELAY-GENUINE-READ", "Here are the tasks assigned to you. The one due this week is first."],
  ["w90/B1", "Here are the tasks assigned to you."],
];

/**
 * Every fabricated-write case the earlier packets shipped, one per row: w199's two, w126's claim, and the five w215
 * had to add because its header promised prefixes could not evade it. On a turn with no card, proposal or result all
 * eight are lies about a write.
 */
const CLAIM_SHAPES: [string, string][] = [
  ["w199 RED-READ-THEN-CLAIM", "Here are your tasks. I've assigned the late one to Sam and it is done now."],
  ["w199 RED-IRRELEVANT-READ", "Done - I deleted it for you."],
  ["w126 CLAIM", "Done - I reassigned it for you."],
  ["w215 perfect passive", "It has been reassigned to Sam."],
  ["w215 bare participle", "Reassigned."],
  ["w215 participle header", "Successfully reassigned to Sam."],
  ["w215 first person, prefixed verb", "I have reassigned it to Sam."],
  ["w215 first person, un- verb", "I've unassigned it from Sam and given it to Priya."],
];

/** The two boundary rows: an honest sentence carrying a claim word, and a claim carrying none. */
const HONEST_WITH_CLAIM_WORD = "3 tasks are assigned to you.";
const CLAIM_WITH_NO_CLAIM_WORD = "It's done.";

/**
 * A word-list detector of the family w107->w164 shipped: "a sentence that mentions a change verb is a claim". It is
 * the hypothesis under test at the boundary, kept here so the inversion can be shown rather than described.
 */
const WORD_LIST = /\b(?:re|un)?(?:assign|chang|updat|edit|modif|renam|mark|delet|remov|complet|finish|clos)\w*/;

describe("w243 SHO-2693: the matrix, and the boundary the predicate is decided on", () => {
  useFakeModel();

  it("w243/MATRIX-DATA: every honest shape is relayed - claimsWrite says no", () => {
    for (const [label, sentence] of DATA_SHAPES) {
      console.log(`w243 MATRIX/DATA ${label} -> claimsWrite=${claimsWrite(sentence)}`);
      expect(claimsWrite(sentence), `${label}: ${sentence}`).toBe(false);
    }
  });

  it("w243/MATRIX-CLAIM: every fabricated write is refused - claimsWrite says yes", () => {
    for (const [label, sentence] of CLAIM_SHAPES) {
      console.log(`w243 MATRIX/CLAIM ${label} -> claimsWrite=${claimsWrite(sentence)}`);
      expect(claimsWrite(sentence), `${label}: ${sentence}`).toBe(true);
    }
  });


  it("w243/BOUNDARY-HONEST: a true sentence that contains a claim word reaches the person, byte-exact", async () => {
    const { lead, projectId, taskId } = await fixture();
    const before = await stateOf(lead, projectId, taskId);
    // The read returned rows, so the sentence is what the rows say - even though it contains "assigned".
    expect(WORD_LIST.test(HONEST_WITH_CLAIM_WORD)).toBe(true); // a word list would call this a claim ...
    script(
      () => [tu("my_tasks", { filter: "all_open" })],
      () => [say(HONEST_WITH_CLAIM_WORD)],
    );
    const { messages } = await sendMessage(actor(lead), READ_REQUEST);
    const reply = lastAssistant(messages);
    console.log(
      `w243 BOUNDARY/HONEST ${JSON.stringify(HONEST_WITH_CLAIM_WORD)} -> claimsWrite=${claimsWrite(HONEST_WITH_CLAIM_WORD)} wordList=${WORD_LIST.test(HONEST_WITH_CLAIM_WORD)} kind=${reply.kind} reply=${JSON.stringify(reply.text)}`,
    );
    expect(reply.text).toBe(HONEST_WITH_CLAIM_WORD); // ... and it is relayed anyway: the verb is not the test
    expect(reply.kind).toBe("answer");
    expect(await stateOf(lead, projectId, taskId)).toEqual(before);
  });

  it("w243/BOUNDARY-CLAIM: a claim with no claim word is refused, and nothing changes", async () => {
    const { lead, projectId, taskId } = await fixture();
    const before = await stateOf(lead, projectId, taskId);
    expect(WORD_LIST.test(CLAIM_WITH_NO_CLAIM_WORD)).toBe(false); // a word list would relay this ...
    script(
      () => [tu("my_tasks", { filter: "all_open" })],
      () => [say(CLAIM_WITH_NO_CLAIM_WORD)],
    );
    const { messages } = await sendMessage(actor(lead), READ_REQUEST);
    const reply = lastAssistant(messages);
    console.log(
      `w243 BOUNDARY/CLAIM ${JSON.stringify(CLAIM_WITH_NO_CLAIM_WORD)} -> claimsWrite=${claimsWrite(CLAIM_WITH_NO_CLAIM_WORD)} wordList=${WORD_LIST.test(CLAIM_WITH_NO_CLAIM_WORD)} kind=${reply.kind} reply=${JSON.stringify(reply.text)}`,
    );
    expect(reply.text.startsWith(NOTHING_CHANGED)).toBe(true); // rejected model prose is replaced by denial and actual records
    expect(reply.text).not.toContain(CLAIM_WITH_NO_CLAIM_WORD);
    expect(await stateOf(lead, projectId, taskId)).toEqual(before);
  });

  it("w243/INVERSION: flipping the predicate's basis flips both boundary verdicts, which is why it is a distinction", () => {
    // Under the word-list hypothesis the two rows get the WRONG verdict, in opposite directions. That is the inversion:
    // it is not that claimsWrite is wider or narrower than a list, it answers a different question.
    expect(WORD_LIST.test(HONEST_WITH_CLAIM_WORD)).toBe(true);
    expect(claimsWrite(HONEST_WITH_CLAIM_WORD)).toBe(false);
    expect(WORD_LIST.test(CLAIM_WITH_NO_CLAIM_WORD)).toBe(false);
    expect(claimsWrite(CLAIM_WITH_NO_CLAIM_WORD)).toBe(true);
    console.log(
      `w243 INVERSION honest: wordList=${WORD_LIST.test(HONEST_WITH_CLAIM_WORD)} claimsWrite=${claimsWrite(HONEST_WITH_CLAIM_WORD)} | claim: wordList=${WORD_LIST.test(CLAIM_WITH_NO_CLAIM_WORD)} claimsWrite=${claimsWrite(CLAIM_WITH_NO_CLAIM_WORD)}`,
    );
  });

  it("w243/RESIDUAL: the three shapes W225 pinned as unblocked are still unblocked - the hole is unchanged", () => {
    // Pinned so a reader of this gate knows the size of what is still open, and can tell it did not shrink or grow.
    for (const missed of ["Consider it reassigned.", "Sam has the late one now.", "I sorted it for you."]) {
      console.log(`w243 RESIDUAL ${JSON.stringify(missed)} -> claimsWrite=${claimsWrite(missed)}`);
      expect(claimsWrite(missed)).toBe(false);
    }
  });
});
