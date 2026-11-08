import {readFileSync,lstatSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import {changeOrgRole} from './bridge.mjs';

function privateFile(path) {
  if(!isAbsolute(path))throw Error('Config unavailable');
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077))throw Error('Config unavailable');
  return readFileSync(path);
}
function config() {
  const path=process.env.APLYD_SHO_ORG_CONFIG;
  const raw=privateFile(path), c=JSON.parse(raw);
  const runtime=privateFile(c.runtime_environment_file), env=dotenv.parse(runtime);
  if(!env.DATABASE_URL||typeof env.SUPER_ADMIN_EMAILS!=='string')throw Error('Native protection source missing');
  return {database:env.DATABASE_URL,policy:{enabled:process.env.APLYD_SHO_ORG_WRITER_ENABLED==='1',
    workspace:c.workspace_id,reviewers:c.reviewer_ids,reference:c.review_reference,
    protectedEmails:env.SUPER_ADMIN_EMAILS.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean),
    configDigest:createHash('sha256').update(raw).update(runtime).digest('hex')}};
}
let db;
try {
  let input='';for await(const part of process.stdin){input+=part;if(input.length>32768)throw Error('Request too large');}
  const c=config(); db=new pg.Client({connectionString:c.database,connectionTimeoutMillis:4000,
    ssl:process.env.APLYD_SHO_TEST_CA?{ca:readFileSync(process.env.APLYD_SHO_TEST_CA,'utf8'),servername:'db'}:undefined});
  await db.connect();
  const result=await changeOrgRole(db,c.policy,JSON.parse(input),()=>config().policy.configDigest===c.policy.configDigest);
  process.stdout.write(JSON.stringify(result));
} catch {process.stderr.write('SHO organisation operation unconfirmed; reconcile before retry.\n');process.exitCode=1;}
finally {await db?.end();}
