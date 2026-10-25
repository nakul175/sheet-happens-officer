import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import test from "node:test";
const base="5346f49f187d41082becb7dacf87237656295aa2";
const allowed=new Set(["src/app/(app)/SetOwnPassword.tsx", "src/app/(app)/layout.tsx", "src/app/(app)/tasks/[id]/TaskPage.tsx", "src/app/(app)/tasks/[id]/layout.tsx", "src/app/(app)/tasks/[id]/not-found.tsx", "src/app/(app)/tasks/[id]/page.tsx", "src/app/signin/SignInForm.tsx", "src/app/signin/page.tsx", "src/components/ReturnToBridge.tsx", "src/components/api.ts", "src/lib/auth.ts", "src/lib/return-to.ts", "src/lib/task-access.ts", "src/lib/tasks.ts", "src/proxy.ts"]);
test("scoped four contains only return-path runtime delta over actual production",()=>{
 const changed=execFileSync("git",["diff","--name-only",base,"--","src"],{encoding:"utf8"}).trim().split("\n").filter(Boolean);
 assert.ok(changed.length);for(const f of changed)assert.ok(allowed.has(f),f);
 for(const p of ["prisma","package.json","package-lock.json","server.js","src/lib/central-client.ts","src/lib/central-status.ts","src/app/api/auth/aplyd","src/app/api/suite"])
  assert.equal(execFileSync("git",["diff",base,"--",p],{encoding:"utf8"}),"",p);
});
test("central entry and suite bridge remain while bounded next is used",()=>{
 const form=readFileSync("src/app/signin/SignInForm.tsx","utf8");
 assert.ok(form.includes('Continue with Aplyd'));assert.ok(form.includes('/api/auth/aplyd/start'));assert.ok(form.includes('/api/suite/authorize?'));assert.ok(form.includes('safeReturnPath(next, 1)'));
});
