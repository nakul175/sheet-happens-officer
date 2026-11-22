import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const release=readFileSync(new URL('../../deploy/release.sh',import.meta.url),'utf8');
const workflow=readFileSync(new URL('../../.github/workflows/deploy.yml',import.meta.url),'utf8');
test('app release checks prerequisites but cannot apply migration or install jobs',()=>{
 assert.match(release,/prisma migrate status/);
 assert.doesNotMatch(release,/prisma migrate (deploy|dev|reset)|prisma db (push|execute)|crontab|install_cron/);
 assert.doesNotMatch(release,/install .*job\.sh/);
 assert.ok(release.indexOf('prisma migrate status')<release.indexOf('switch "$REL"'));
});
test('push is test-only; release requires manual opt-in and exact revision',()=>{
 assert.match(workflow,/github\.event_name == 'workflow_dispatch' && inputs\.deploy == true/);
 assert.match(workflow,/default: false/);assert.match(workflow,/environment: production/);
 assert.match(workflow,/\[ "\$APPROVED_SHA" = "\$GITHUB_SHA" \]/);
});
test('release rejects abbreviated or shell-injected revision before any work',()=>{
 assert.match(release,/\^\[0-9a-f\]\{40\}\$/);
});

test('workflow never provisions host config or database credentials during app cut',()=>{
 assert.doesNotMatch(workflow,/cat > \/etc\/sho|secrets\.DATABASE_URL|secrets\.DIRECT_DATABASE_URL|Write settings and secrets/);
});
