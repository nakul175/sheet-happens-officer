// SHO-2693 w148: one rule for "this sentence asserts that a write finished", read by engine.ts buildReply on the branch
// where the turn's own state already proves nothing was written. No server imports, like echo.ts.
//
// Why a stem and not a word. w107 -> w126 was a gate on the REQUEST: `/\bassign\b/` widened to `/\b(?:re)?assign\b/`,
// and it still missed "reassigning" (no word boundary after the stem) and "unassign" (none before it). Here the text is
// lower-cased and its intra-word separators are dropped ("re-assign" -> "reassign"), and a verb stem is then matched as
// a plain substring. Every inflection of the same verb - assign, assigns, assigned, assigning, reassign, reassigned,
// reassigning, unassign, unassigned - contains its stem, so no new ending, hyphen, prefix or capitalisation of these
// verbs can evade it. That is the whole point: the detector cannot be defeated by a thesaurus of the same word.
//
// What it can miss is a different verb for the same act ("I sorted it for you"), caught only by the completion frame
// below, or a claim with no verb at all and no completion word. That residual is stated in W148-REPORT.md, not hidden.

/** Change verbs, as stems: matching the stem matches every inflection, so this list gates the *family*, not a spelling. */
const STEM =
  "(?:assign|chang|updat|edit|modif|renam|mark|delet|remov|archiv|restor|trash|creat|add|mov|switch|transfer|complet|finish|clos|cancel|reopen|schedul|set|reset|confirm|approv|reject|promot|demot|deactivat|invit|shar)";

/** First person that is the subject of the change verb: "I reassigned", "I have just reassigned", "I've unassigned". */
const I_DID = new RegExp(`\\b(?:i|i've|i\\u2019ve|i have|we|we've)\\s+(?:have\\s+|had\\s+|'ve\\s+)?(?:just\\s+|already\\s+|now\\s+|also\\s+|then\\s+|successfully\\s+)?${STEM}`);

/** The change verb done to the thing: "it has been reassigned", "the task was assigned". */
const WAS_DONE = new RegExp(`\\b(?:has|have|had|was|were|is|are)\\s+(?:now\\s+|already\\s+|been\\s+)*${STEM}`);

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
 */
export function claimsWrite(text: string): boolean {
  const flat = text.toLowerCase().replace(/(?<=[a-z])[-–—_](?=[a-z])/g, "");
  for (const raw of flat.split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.trim();
    if (!s || s.endsWith("?")) continue;
    if (I_DID.test(s) || WAS_DONE.test(s) || ONLY_VERB.test(s) || BARE.test(s)) return true;
    if (MARKER.test(s) && new RegExp(STEM).test(s)) return true;
  }
  return false;
}
