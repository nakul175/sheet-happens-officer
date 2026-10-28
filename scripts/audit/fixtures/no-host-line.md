# Receipt — 2693 local run

Ran the suite in this worktree on darwin, against the dev server on 127.0.0.1:3246:

```
$ npx vitest run tests/sho-2693.test.ts tests/sho-2693-required-flag.test.ts
 Test Files  2 passed (2)
      Tests  23 passed (23)
```

No host or slot identity appears in this receipt: no `host=`, no unit, no account.
