import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeApprover500Diagnostic(
  errorId: string | null,
  logOffset: number,
  logPath = 'server.log',
  outputPath = 'test-results/approver-valid-swap/diagnostic.json',
) {
  let recent = '';
  let logPresent = false;
  try {
    recent = readFileSync(logPath).subarray(Math.max(0, logOffset)).toString();
    logPresent = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const validErrorId = errorId && /^[0-9a-f-]{36}$/.test(errorId) ? errorId : null;
  const matches = [...recent.matchAll(/unexpected error (P\d{4}(?:\/(?:08|22|23|25|28|40|42|53|55|57|58|XX)[0-9A-Z]{3})?|(?:08|22|23|25|28|40|42|53|55|57|58|XX)[0-9A-Z]{3}|UNKNOWN) ([0-9a-f-]{36})/g)];
  const safeCodes = validErrorId ? matches.filter((match) => match[2] === validErrorId).map((match) => match[1]) : [];
  const diagnostic = {
    status: 500,
    errorId: validErrorId,
    safeCodes,
    logPresent,
    logBytesSinceRequest: Buffer.byteLength(recent),
    attribution: safeCodes.length ? 'matched response ID' : logPresent ? 'no matching sanitized server line' : 'server log unavailable',
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(diagnostic, null, 2));
  return diagnostic;
}
