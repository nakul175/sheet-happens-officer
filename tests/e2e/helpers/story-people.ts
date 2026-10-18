// A plain Member for story specs: a new nakul17+ alias per test, deactivated afterwards.
// The shared member fixture skips when SHO_MEMBER_EMAIL is unset. These specs must not.
import { test as base, zz } from "../support";
import { qaEmail, signInAlias } from "./qa-alias";

let seq = 0;

export const test = base.extend({
  member: async ({ browser, admin }, run) => {
    const label = `m${++seq}`;
    const signed = await signInAlias(browser, qaEmail(label), zz(label));
    try {
      await run(signed.who);
    } finally {
      try { await admin.api.post(`/api/team/${signed.who.user.id}/deactivate`, { reassign: "leaders" }); } catch { /* already gone */ }
      await signed.ctx.close();
    }
  },
});
