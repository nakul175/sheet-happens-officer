import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function assertTaskSheetPassed(report) {
  const stats = report.stats;
  if (!stats || stats.expected !== 9 || stats.unexpected !== 0 || stats.skipped !== 0 || stats.flaky !== 0 || (report.errors ?? []).length) throw Error('Task sheet requires nine actual passes without failures/skips/flakes/errors');
  const cases = [];
  function visit(suites) {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) cases.push(...(spec.tests ?? []));
      visit(suite.suites);
    }
  }
  visit(report.suites);
  if (cases.length !== 9 || cases.some(test => test.expectedStatus !== 'passed' || test.status !== 'expected' || test.results?.length !== 1 || test.results[0].status !== 'passed')) throw Error('Every task sheet case must expect and actually pass once; expected failures are refused');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertTaskSheetPassed(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  console.log('SHO-2905: nine actual task sheet browser passes; no physical-device claim');
}
