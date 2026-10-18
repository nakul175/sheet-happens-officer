// APL-2693: Assign without a person asks to whom (parent APL-2513 AC2).
// One test per acceptance criterion. Each turn is one short prompt to POST /api/concierge/messages.
// The harness (support, g2, jim-concierge) is the same one the other files in this directory use.
import { test, expect, zz } from "../support";
import { newProject, newTask } from "../g2";
import { cleanChat } from "../helpers/jim-http";
import { ask, cardOf, replyOf, requireModel, taskOf } from "../helpers/jim-concierge";

test.describe.configure({ timeout: 150_000 });

const asksToWhom = (text: string) => /\bwho(?:m)?\b/i.test(text) && /\bassign/i.test(text) && text.includes("?");

test.describe("APL-2693", { tag: "@APL-2693" }, () => {
  test(
    '@APL-2693 qa:TC-APL2693-67ec712c@v1 AC1: Assign "<title>". ends as a question asking to whom',
    { tag: ["@APL-2693", "@AC1"] },
    async ({ admin, later }) => {
      await requireModel(admin);
      await cleanChat(admin, later);
      const project = await newProject(admin, later, { label: "apl2693-who" });
      const title = zz("unassigned-ask");
      await newTask(admin, project.id, { title, assigneeId: admin.user.id });
      const asked = await ask(admin, `Assign "${title}".`);
      expect(asked.status, JSON.stringify(asked.json)).toBe(200);
      const reply = replyOf(asked.messages);
      expect(reply?.kind === "text" || reply?.kind === "choices", reply?.kind).toBe(true);
      expect(reply?.text.trim()).not.toBe("");
      expect(asksToWhom(reply?.text ?? "")).toBe(true);
    },
  );

  test(
    "@APL-2693 qa:TC-APL2693-e9f6715e@v1 AC2: no confirm card, and the assignee is unchanged",
    { tag: ["@APL-2693", "@AC2"] },
    async ({ admin, later }) => {
      await requireModel(admin);
      await cleanChat(admin, later);
      const project = await newProject(admin, later, { label: "apl2693-nocard" });
      const title = zz("unassigned-ask");
      const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id });
      const asked = await ask(admin, `Assign "${title}".`);
      expect(asked.status, JSON.stringify(asked.json)).toBe(200);
      expect(cardOf(asked.messages), "a missing person is not guessed").toBeFalsy();
      expect(asked.messages.some((m) => m.kind === "card" || m.card)).toBe(false);
      expect((await taskOf(admin, id)).assignee.id).toBe(admin.user.id);
    },
  );

  test(
    '@APL-2693 qa:TC-APL2693-cff94f8a@v1 AC3: Assign "<title>" to <member>. still returns a confirm card',
    { tag: ["@APL-2693", "@AC3"] },
    async ({ admin, member, later }) => {
      await requireModel(admin);
      await cleanChat(admin, later);
      const project = await newProject(admin, later, { label: "apl2693-named", members: [{ who: member, role: "EDITOR" }] });
      const title = zz("named-ask");
      const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id });
      const memberName = String(member.user.name);
      const asked = await ask(admin, `Assign "${title}" to ${memberName}.`);
      expect(asked.status, JSON.stringify(asked.json)).toBe(200);
      const card = cardOf(asked.messages);
      expect(card?.status).toBe("PENDING");
      expect(card?.canConfirm).toBe(true);
      expect((card?.changes ?? []).map((c) => c.after ?? "").join(" ")).toContain(memberName);
      expect((await taskOf(admin, id)).assignee.id).toBe(admin.user.id);
    },
  );
});
