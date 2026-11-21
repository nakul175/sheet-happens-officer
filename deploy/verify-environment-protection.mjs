// Fail closed if the manual production workflow has no independent approval gate.
import { pathToFileURL } from 'node:url';

export function assessEnvironmentProtection(environment) {
  const rules = environment?.protection_rules;
  if (!Array.isArray(rules)) return 'PROTECTION_RULES_MISSING';
  const reviewers = rules.find((rule) => rule.type === 'required_reviewers');
  if (!reviewers || !Array.isArray(reviewers.reviewers) || reviewers.reviewers.length === 0) return 'REQUIRED_REVIEWERS_MISSING';
  if (reviewers.prevent_self_review !== true) return 'SELF_REVIEW_ALLOWED';
  if (environment.can_admins_bypass !== false) return 'ADMIN_BYPASS_ALLOWED';
  return null;
}

export async function verifyEnvironmentProtection(repository, fetcher = fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('INVALID_REPOSITORY');
  const response = await fetcher(`https://api.github.com/repos/${repository}/environments/production`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('ENVIRONMENT_UNAVAILABLE');
  const code = assessEnvironmentProtection(await response.json());
  if (code) throw new Error(code);
  return 'PRODUCTION_APPROVAL_PROTECTED';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyEnvironmentProtection(process.env.GITHUB_REPOSITORY ?? '')
    .then((result) => console.log(result))
    .catch((error) => { console.error('PRODUCTION_APPROVAL_CHECK_FAILED', error.message); process.exitCode = 1; });
}
