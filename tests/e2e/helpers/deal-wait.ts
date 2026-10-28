// APL-2538 AC3 (SHO-2920). Convert-to-deal pushes the deal it just created, so the story must wait for that deal.
// A predicate that accepts "any /projects/ path", or "some project that is not the source", resolves on a URL that is
// not the record under test: the first matched the pre-move URL, the second matches any sibling project. Kept free of
// Playwright imports so a plain Vitest file can hold it to the AC.
export const atDeal = (dealId: string) => (url: URL) => url.pathname === `/projects/${dealId}`;

