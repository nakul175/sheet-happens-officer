// SHO-2693 w148: one rule for "this sentence asserts that a write finished", read by engine.ts buildReply. No server
// imports, like echo.ts.
//
// w215 restores it and puts it back in front of BOTH branches. w183 deleted this file and gated the reply on
// `turn.reads.records` alone (engine.ts:227), which closed the no-evidence branch by construction but made any real
// read a free relay: a read of rows licensed "I've assigned the late one to Sam and it is done now." (w199
// RED-READ-THEN-CLAIM) and even a read of something else licensed "Done - I deleted it for you." (w199
// RED-IRRELEVANT-READ). Both sentences were blocked by this predicate before w183, and both are blocked by it again.
// The predicate is a blacklist and cannot be complete; that is why it does not stand alone - the structural
// records === 0 rule is still what makes the no-evidence branch safe, and this only adds the outcome check to the
// branch where rows exist. The residual is named in W215-REPORT.md §5 (the product decision, not taken here).
//
// Why a stem and not a word. w107 -> w126 was a gate on the REQUEST: `/\bassign\b/` widened to `/\b(?:re)?assign\b/`,
// and it still missed "reassigning" (no word boundary after the stem) and "unassign" (none before it). Here the text is
// lower-cased and its intra-word separators are dropped ("re-assign" -> "reassign"), and a verb stem is then matched as
// a plain substring. Every inflection of the same verb - assign, assigns, assigned, assigning, reassign, reassigned,
// reassigning, unassign, unassigned - contains its stem, so no new ending, hyphen, prefix or capitalisation of these
// verbs can evade it. That is the whole point: the detector cannot be defeated by a thesaurus of the same word.
//
// SHO-2693 w225 corrects one word of that paragraph. The prefix could evade w215: the stem was matched where it sits,
// so "reassigned" did not match "assign" unless the pattern itself allowed "re", and only ONLY_VERB did (see STEM_P).
// w225 also splits w215's WAS_DONE by ASPECT, because "the task was assigned to Sam" and "you were assigned 3 tasks"
// are one grammatical shape and only the first is a claim - the second is the answer to the ordinary question.
// W225-REPORT.md §5 names what is still missed: an outcome with no verb of the family ("Sam has the late one now.",
// "I sorted it for you.") and a participle as an object complement ("Consider it reassigned.").

/** Change verbs, as stems: matching the stem matches every inflection, so this list gates the *family*, not a spelling. */
const STEM =
  "(?:assign|chang|updat|edit|modif|renam|mark|delet|remov|archiv|restor|trash|creat|add|mov|switch|transfer|complet|finish|clos|cancel|reopen|schedul|set|reset|confirm|approv|reject|promot|demot|deactivat|invit|shar)";

/**
 * SHO-2693 w225: the same stem WITH the prefixes English puts on this family. w215's header claimed "no prefix can
 * evade it", but only `ONLY_VERB` carried this class: `I_DID` and `WAS_DONE` matched the bare stem at a fixed position,
 * so "I have reassigned it to Sam.", "I've unassigned it from Sam." and "It has been reassigned to Sam." were all
 * relayed by w215 on a read-present turn (tests/sho-2693-w225.test.ts FABRIC/perfect-passive and the two first-person
 * rows). A postfix, hyphen or capitalisation really cannot evade it; a prefix could, and now cannot.
 */
const STEM_P = `(?:re|un|de|dis)?${STEM}`;

/** First person that is the subject of the change verb: "I reassigned", "I have just reassigned", "I've unassigned". */
const I_DID = new RegExp(`\\b(?:i|i've|i\u2019ve|i have|we|we've)\\s+(?:have\\s+|had\\s+|'ve\\s+)?(?:just\\s+|already\\s+|now\\s+|also\\s+|then\\s+|successfully\\s+)?${STEM_P}`);

/**
 * The change already happened, said in the perfect: "it has been reassigned", "I have reassigned it", "it had been
 * deleted". Aspect is the discriminator w225 uses, and it is grammatical rather than lexical:
 *
 *   perfect (has/have/had [been] + verb)  → the sentence asserts a change. Refused.
 *   simple   (is/are/was/were + verb)     → the sentence describes a state. Relayed - when rows exist it is what the
 *                                            rows say ("3 tasks are assigned to you", "you were assigned 3 tasks").
 *
 * w215 counted the simple aspect as a claim too (`WAS_DONE`), which replaced a person's real answer with "Nothing has
 * changed" - the ordinary question this packet exists to keep answerable (w225/LEGIT rows).
 */
const PERFECT = new RegExp(`\\b(?:has|have|had)\\s+(?:now\\s+|already\\s+|successfully\\s+)?(?:been\\s+)?${STEM_P}`);

/**
 * The change handed to somebody other than the asker: "assigned to Sam", "unassigned from Sam". "to you", "for me",
 * "to your queue" is the asker's own row and therefore data, which is why the negative lookahead is the whole point.
 * This is what keeps a simple-aspect passive from being a free relay once PERFECT stopped covering it.
 */
const TO_OTHER = new RegExp(`\\b${STEM_P}\\w*\\s+(?:to|from|for)\\s+(?!(?:you|me|us|your|my|our)\\b)\\w`);


/**
 * A completion word next to a change verb: "Done - I reassigned it for you" also matches I_DID; this catches the rest.
 * "done on/in/at/by/from/through/via" is excluded on purpose: "Deactivating people is done on the Team screen" says
 * WHERE the action is performed, not that it has been performed, and that sentence is the screens-only answer this
 * concierge is required to give (concierge.test.ts AC3). Only a plain "done" - "Done for you", "that is done" - is a
 * completion claim.
 */
const MARKER = /\b(?:done(?!\s+(?:on|in|at|by|from|through|via)\b)|already|success\w*|all set|as requested|as asked|for you)\b/;

/**
 * The whole sentence is the change verb: "Reassigned." A bare participle asserts the same thing as "I reassigned it".
 * The optional prefix is spelled out here because the anchors put the stem at the start of the sentence: "reassigned"
 * begins with "re", so `STEM` alone would not sit at position 0.
 */
const ONLY_VERB = new RegExp(`^[^a-z]*(?:re|un|de|dis)?${STEM}[a-z]*[^a-z]*$`);

/** A completion word with no verb at all: "Done.", "All set", "It's done." */
const BARE =
  /^(?:ok(?:ay)?|sure|great|all right|alright|no problem|perfect)?[\s,.:;-]*(?:all\s+)?(?:done|finished|complete|completed|taken care of|handled)\b|\b(?:it|that|this)(?:'s| is| was)\s+(?:all\s+)?(?:done|finished|complete|handled)\b/;

/**
 * True when `text` tells the person that a change was made. A question never counts: asking "Who should I assign it
 * to?" is the opposite of claiming a write. Sentences are judged one at a time, because a reply can mix an honest list
 * with a lying closing line.
 *
 * SHO-2693 w225: the four frames are (1) a first-person agent, (2) the perfect aspect, (3) the change handed to a third
 * party, (4) a completion word next to the verb, plus a bare verb as the whole sentence. Frames 1-3 are aspect- and
 * agent-based, not a word list, which is what lets the data sentences in w225/LEGIT through while refusing every
 * FABRIC row in the same file.
 */
export function claimsWrite(text: string, readTasks: readonly { title: string; assignee: string }[] = []): boolean {
  // A tool-grounded list item can attach the current owner as data, e.g.
  // `Budget — due Friday (assigned to Sam)`. This is not a claim of a write.
  // Exempt only that exact parenthetical on a line naming the matching fetched
  // task; first-person/perfect/completion claims elsewhere still reach the gate.
  const checked = readTasks.length ? text.split("\n").map((line) => {
    let factual = line;
    for (const task of readTasks) {
      if (task.title && task.assignee && line.includes(task.title)) {
        factual = factual.replaceAll(`(assigned to ${task.assignee})`, "(current assignee)");
      }
    }
    return factual;
  }).join("\n") : text;
  const flat = checked.toLowerCase().replace(/(?<=[a-z])[-–—_](?=[a-z])/g, "");
  for (const raw of flat.split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.trim();
    if (!s || s.endsWith("?")) continue;
    if (I_DID.test(s) || PERFECT.test(s) || TO_OTHER.test(s) || ONLY_VERB.test(s) || BARE.test(s)) return true;
    if (MARKER.test(s) && new RegExp(STEM).test(s)) return true;
  }
  return false;
}
