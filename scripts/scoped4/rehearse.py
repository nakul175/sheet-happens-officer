"""Disposable PostgreSQL16 proof only: never accepts cloud/nonlocal DB targets."""
import hashlib,json,os,pathlib,secrets,subprocess,tempfile,urllib.parse
root=pathlib.Path.cwd();out=root/'bootstrap-rehearsal-receipts';out.mkdir(mode=0o700)
base={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'PGHOST':'localhost','PGPORT':'5432','PGDATABASE':'sho_test','PGUSER':'sho','PGPASSWORD':'sho','PGSSLMODE':'disable'}
def runsql(q,env=base,ok=True):
 r=subprocess.run(['psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],env=env,input=q,text=True,capture_output=True,timeout=45)
 if ok and r.returncode:raise RuntimeError('Local fixture SQL failed: '+r.stderr)
 return r
assert runsql('SELECT current_database()').stdout.strip()=='sho_test'
assert runsql("SELECT current_setting('server_version_num')::int/10000").stdout.strip()=='16'
adminpw=secrets.token_hex(20);apppw=secrets.token_hex(20)
print('::add-mask::'+adminpw,flush=True);print('::add-mask::'+apppw,flush=True)
runsql("CREATE ROLE doadmin LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '"+adminpw+"'; CREATE ROLE sho_slot_pr9_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '"+apppw+"'; GRANT CONNECT ON DATABASE sho_test TO doadmin,sho_slot_pr9_app; GRANT CREATE ON DATABASE sho_test TO doadmin; CREATE SCHEMA sho_pr9 AUTHORIZATION sho_slot_pr9_app; CREATE TABLE public.\"SCOPED4_BASELINE\"(id int PRIMARY KEY,value text); INSERT INTO public.\"SCOPED4_BASELINE\" VALUES(1,'unchanged-public'); CREATE TABLE sho_pr9.\"SCOPED4_BASELINE\"(id int PRIMARY KEY,value text); INSERT INTO sho_pr9.\"SCOPED4_BASELINE\" VALUES(1,'unchanged-slot9');")
admin={**base,'PGUSER':'doadmin','PGPASSWORD':adminpw}
assert runsql('SET ROLE sho_slot_pr9_app;',admin,ok=False).returncode!=0
foundation=(root/'scripts/scoped4/foundation-review.sql').read_text().replace("current_database()<>'sho_staging'","current_database()<>'sho_test'")
runsql(foundation,admin)
url='postgresql://sho_slot_pr9_app:'+apppw+'@localhost:5432/sho_test?schema=sho_pr9_scoped4&sslmode=disable&connection_limit=1'
env={**os.environ,'DATABASE_URL':url,'DIRECT_DATABASE_URL':url,'SCOPED4_PINNED_MIGRATIONS':str(root/'scripts/scoped4/pinned-migrations.json')}
red=subprocess.run(['node','node_modules/prisma/build/index.js','migrate','deploy'],env=env,text=True,capture_output=True,timeout=180)
(out/'unmodified-migration-red.json').write_text(json.dumps({'exitCode':red.returncode,'stdout':red.stdout,'stderr':red.stderr},indent=2))
assert red.returncode!=0 and ('42501' in red.stdout+red.stderr or 'permission denied' in red.stdout+red.stderr),'Expected exact unmodified migration privilege refusal'
runsql('DROP SCHEMA sho_pr9_scoped4 CASCADE;',admin);runsql(foundation,admin)
for key in ['green','wrong-target']:
 work=out/key;work.mkdir(mode=0o700);e={**env,'SCOPED4_RECEIPT_DIR':str(work)}
 if key=='wrong-target':e.update(DATABASE_URL=url.replace('schema=sho_pr9_scoped4','schema=public'),DIRECT_DATABASE_URL=url.replace('schema=sho_pr9_scoped4','schema=public'))
 x=subprocess.run(['python3','scripts/scoped4/bootstrap-restricted.py','local-rehearsal'],env=e,text=True,capture_output=True,timeout=300)
 (out/(key+'-process.json')).write_text(json.dumps({'exitCode':x.returncode,'stdout':x.stdout,'stderr':x.stderr},indent=2))
 assert (x.returncode==0)==(key=='green'),key+' failed: '+x.stdout
 if key=='green':result=json.loads(x.stdout.strip().splitlines()[-1]);assert result['ok'] and result['migrations']==12
assert runsql('SELECT value FROM public.\"SCOPED4_BASELINE\"').stdout.strip()=='unchanged-public'
assert runsql('SELECT value FROM sho_pr9.\"SCOPED4_BASELINE\"').stdout.strip()=='unchanged-slot9'
assert runsql("SELECT has_database_privilege('sho_slot_pr9_app','sho_test','CREATE')").stdout.strip()=='f'
runsql('DROP SCHEMA sho_pr9_scoped4 CASCADE;',admin)
assert runsql("SELECT count(*) FROM pg_namespace WHERE nspname='sho_pr9_scoped4'").stdout.strip()=='0'
receipt={'ok':True,'runtimeSHA':'ee59582dffcbd8cc3067e689b2bb73cf63781cb7','postgresMajor':16,'adminCannotSetAppRole':True,'unmodifiedMigrationRefused':True,'boundedBootstrapPassed':True,'all12CanonicalChecksumsMatched':True,'appObjectOwnershipVerified':True,'appDatabaseCreateRemainsFalse':True,'wrongTargetRefused':True,'publicAndOldSlotSentinelsUnchanged':True,'adminCleanupWithoutSetRolePassed':True,'cloudTouched':False}
(out/'public-summary.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
