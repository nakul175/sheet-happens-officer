/** Accept only the two intended assertion failures, not fixture, runner or cleanup errors. */
export function validateStalledM1(report, testSource) {
  const lines = testSource.split("\n");
  const results = (report.testResults ?? []).flatMap(suite => suite.assertionResults ?? []);
  const failed = results.filter(test => test.status === "failed");
  const titles = failed.map(test => test.title);
  const exactRowFailure = test => {
    if (test.failureMessages?.length !== 1) return false;
    const message = test.failureMessages[0];
    if (!message.startsWith("AssertionError:") || !message.includes("to deeply equal")) return false;
    const locations = [...message.matchAll(/jobs-stalled-crm\.test\.ts:(\d+):\d+/g)];
    return locations.some(match => lines[Number(match[1]) - 1]?.trim().startsWith("expect(second.after).toEqual(second.before)"));
  };
  if (failed.length !== 2 || !titles.some(t => t.includes("all preserves exact world notices")) || !titles.some(t => t.includes("admins hides non-admin deals")) || failed.some(test => !exactRowFailure(test)) || results.some(test => !["failed", "skipped"].includes(test.status))) {
    throw new Error("M1 was not detected by both exact-row assertions; inspect saved report");
  }
  return titles;
}
