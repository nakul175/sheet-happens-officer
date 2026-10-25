"""Pinned scoped4 bootstrap: no admin credential, DB-wide grant, shadow DB or migration-file edit.
Manually applies the canonical initial DDL minus exactly its already-satisfied public-schema
creation; only after successful DDL/ownership verification uses official migrate resolve.
Any failure leaves the owned staging schema for explicit review, never a blind resume.
"""
import hashlib,json,os,pathlib,stat,subprocess,sys,time,urllib.parse
SHA='ee59582dffcbd8cc3067e689b2bb73cf63781cb7';SCHEMA='sho_pr9_scoped4';ROLE='sho_slot_pr9_app'
INIT='20261017000000_init';INIT_HASH='33fe5dfa96809a16aad8c81dd3ff7009a5396008530ad42c0626148253474d6c'
PREFIX=b'-- CreateSchema\nCREATE SCHEMA IF NOT EXISTS "public";\n\n'
phase='arguments';work=None;before=None
class Refusal(Exception):pass
def check(x,reason='guard-refused'):
 if not x:raise Refusal(reason)
def h(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def save(name,data):
 p=work/name;fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f:json.dump(data,f,indent=2)
def metadata():
 return sql("SELECT jsonb_build_object('schemas',(SELECT jsonb_agg(jsonb_build_array(oid,nspname,nspowner,nspacl::text) ORDER BY oid) FROM pg_namespace WHERE nspname IN ('public','sho_pr9')),'classes',(SELECT jsonb_agg(jsonb_build_array(c.oid,c.relname,c.relkind,c.relowner,c.relacl::text) ORDER BY c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','sho_pr9')),'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl::text,p.proconfig) ORDER BY p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','sho_pr9')),'types',(SELECT jsonb_agg(jsonb_build_array(t.oid,t.typowner,t.typacl::text) ORDER BY t.oid) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname IN ('public','sho_pr9')),'dbACL',(SELECT datacl::text FROM pg_database WHERE datname=current_database()),'role',(SELECT jsonb_build_array(oid,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolconfig) FROM pg_roles WHERE rolname='sho_slot_pr9_app'),'memberships',(SELECT jsonb_agg(jsonb_build_array(m.roleid,m.member,m.grantor,m.admin_option,m.inherit_option,m.set_option) ORDER BY m.roleid,m.member,m.grantor) FROM pg_auth_members m WHERE m.roleid=(SELECT oid FROM pg_roles WHERE rolname='sho_slot_pr9_app') OR m.member=(SELECT oid FROM pg_roles WHERE rolname='sho_slot_pr9_app')))" )
def sql(query):
 r=subprocess.run(['psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],env=pgenv,input=query,text=True,capture_output=True,timeout=45)
 if r.returncode:
  save('failure-'+str(time.time_ns())+'.json',{'phase':phase,'stderr':r.stderr,'stdout':r.stdout});raise Refusal('sql-operation-failed')
 return r.stdout.strip()
def owners():
 return json.loads(sql("SELECT json_build_object('wrongRelations',(SELECT count(*) FROM pg_class WHERE relnamespace='sho_pr9_scoped4'::regnamespace AND relowner<>(SELECT oid FROM pg_roles WHERE rolname='sho_slot_pr9_app')),'wrongTypes',(SELECT count(*) FROM pg_type WHERE typnamespace='sho_pr9_scoped4'::regnamespace AND typowner<>(SELECT oid FROM pg_roles WHERE rolname='sho_slot_pr9_app')),'wrongFunctions',(SELECT count(*) FROM pg_proc WHERE pronamespace='sho_pr9_scoped4'::regnamespace AND proowner<>(SELECT oid FROM pg_roles WHERE rolname='sho_slot_pr9_app')))"))
def prisma(args,label):
 r=subprocess.run(['node','node_modules/prisma/build/index.js',*args],cwd=release,env=env,text=True,capture_output=True,timeout=240)
 save(label+'.json',{'phase':phase,'exitCode':r.returncode,'stdout':r.stdout,'stderr':r.stderr});check(r.returncode==0,'prisma-command-failed')
try:
 check(sys.argv[1:] in (['cloud'],['local-rehearsal']))
 local=sys.argv[1]=='local-rehearsal';release=pathlib.Path.cwd().resolve()
 if not local:check(os.geteuid()==995 and release==pathlib.Path('/home/shoslot/pr9/releases/ee59582') and (release/'BUILD_SHA').read_text().strip()==SHA)
 work=pathlib.Path(os.environ['SCOPED4_RECEIPT_DIR']).resolve();ws=work.lstat();check(stat.S_ISDIR(ws.st_mode) and ws.st_uid==os.geteuid() and stat.S_IMODE(ws.st_mode)==0o700 and not work.is_symlink())
 if not local:check(work.parent==pathlib.Path('/home/shoslot/pr9/var') and work.name.startswith('scoped4-bootstrap-'))
 env={k:os.environ[k] for k in ['PATH','HOME','DATABASE_URL','DIRECT_DATABASE_URL'] if k in os.environ};check(env.get('DIRECT_DATABASE_URL')==env.get('DATABASE_URL'))
 env.update(CHECKPOINT_DISABLE='1',DO_NOT_TRACK='1',PRISMA_HIDE_UPDATE_MESSAGE='true')
 u=urllib.parse.urlparse(env['DATABASE_URL']);pairs=urllib.parse.parse_qsl(u.query,keep_blank_values=True);qs=dict(pairs)
 check(u.scheme in ('postgres','postgresql') and not u.fragment and u.username==ROLE and u.password and len(qs)==len(pairs) and qs.get('schema')==SCHEMA,'target-refused')
 check(all(k in ('schema','sslmode','sslaccept','sslcert','sslrootcert','connection_limit','pool_timeout','connect_timeout') for k in qs),'url-override-refused')
 if local:check(u.hostname in ('localhost','127.0.0.1') and u.port==5432 and u.path=='/sho_test','local-target-refused')
 else:check(u.hostname=='private-sho-db-do-user-45345612-0.k.db.ondigitalocean.com' and u.port==25060 and u.path=='/sho_staging' and qs.get('sslaccept')=='strict' and qs.get('sslmode')=='require','cloud-target-refused')
 pgenv={'PATH':env['PATH'],'HOME':env.get('HOME','/tmp'),'PGHOST':u.hostname,'PGPORT':str(u.port),'PGDATABASE':u.path[1:],'PGUSER':ROLE,'PGPASSWORD':urllib.parse.unquote(u.password),'PGAPPNAME':'sho-scoped4-restricted-bootstrap','PGCONNECT_TIMEOUT':'10','PGOPTIONS':'-c search_path=sho_pr9_scoped4 -c lock_timeout=5000 -c statement_timeout=30000'}
 if local:pgenv['PGSSLMODE']='disable'
 else:
  ca=pathlib.Path(qs.get('sslcert',''));check(ca==pathlib.Path('/home/shoslot/pr9/var/active45-8bdde19-db/official-ca.crt') and ca.is_file())
  der=subprocess.check_output(['openssl','x509','-outform','DER'],input=ca.read_bytes());check(hashlib.sha256(der).hexdigest()=='fd536bb0e464f80e14776b3793d33eb9c0476493ddf36dc6ddd27f8bf6ffea37')
  pgenv.update(PGSSLMODE='verify-full',PGSSLROOTCERT=str(ca))
 expected=json.loads(pathlib.Path(os.environ['SCOPED4_PINNED_MIGRATIONS']).read_text());files={p.parent.name:h(p) for p in (release/'prisma/migrations').glob('*/migration.sql')};check(files==expected and files.get(INIT)==INIT_HASH,'migration-source-drift')
 initial=(release/'prisma/migrations'/INIT/'migration.sql').read_bytes();check(initial.startswith(PREFIX));body=initial[len(PREFIX):].decode()
 phase='preflight'
 check(sql('SELECT current_database()||\'|\'||current_user||\'|\'||current_schema()')==u.path[1:]+'|'+ROLE+'|'+SCHEMA)
 check(sql("SELECT current_setting('server_version_num')::int/10000")=='16')
 check(sql("SELECT has_database_privilege(current_user,current_database(),'CREATE')")=='f','unexpected-db-create')
 check(sql("SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='sho_pr9_scoped4'")=='doadmin','schema-owner-drift')
 oid=sql("SELECT oid FROM pg_namespace WHERE nspname='sho_pr9_scoped4'");check(oid.isdigit())
 check(sql("SELECT has_schema_privilege(current_user,'sho_pr9_scoped4','USAGE') AND has_schema_privilege(current_user,'sho_pr9_scoped4','CREATE') AND NOT has_schema_privilege(current_user,'sho_pr9_scoped4','USAGE WITH GRANT OPTION') AND NOT has_schema_privilege(current_user,'sho_pr9_scoped4','CREATE WITH GRANT OPTION')")=='t')
 check(sql("SELECT count(*) FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE n.nspname='sho_pr9_scoped4' AND (a.grantee NOT IN (n.nspowner,(SELECT oid FROM pg_roles WHERE rolname='sho_slot_pr9_app')) OR a.privilege_type NOT IN ('USAGE','CREATE'))")=='0','unexpected-schema-grantee')
 check(sql("SELECT count(*) FROM pg_namespace WHERE nspname='public'")=='1','public-precondition-missing')
 for catalog,field in [('pg_class','relnamespace'),('pg_type','typnamespace'),('pg_proc','pronamespace')]:check(sql('SELECT count(*) FROM '+catalog+' WHERE '+field+"='sho_pr9_scoped4'::regnamespace")=='0','target-not-empty-no-blind-resume')
 before=metadata();save('preflight.json',{'candidateSHA':SHA,'schemaOID':oid,'catalogBeforeSHA256':hashlib.sha256(before.encode()).hexdigest(),'canonicalInitialSHA256':INIT_HASH,'manualInitialBodySHA256':hashlib.sha256(body.encode()).hexdigest(),'databaseCreate':False})
 phase='initial-ddl'
 sql('BEGIN; SET LOCAL search_path=sho_pr9_scoped4;\n'+body+'\nCOMMIT;')
 check(all(x==0 for x in owners().values()),'initial-object-owner-drift');check(metadata()==before,'outside-catalog-drift')
 save('initial-ddl-committed.json',{'candidateSHA':SHA,'schemaOID':oid,'initialDDLCommitted':True,'canonicalInitialSHA256':INIT_HASH,'publicSchemaAlreadyExisted':True,'onlySkippedStatement':'CREATE SCHEMA IF NOT EXISTS "public";','objectsOwnedBy':ROLE})
 phase='canonical-initial-baseline'
 prisma(['migrate','resolve','--applied',INIT],'resolve-initial')
 phase='remaining-canonical-migrations'
 prisma(['migrate','deploy'],'migrate-deploy')
 phase='verification'
 history=json.loads(sql("SELECT coalesce(json_agg(row_to_json(m) ORDER BY migration_name),'[]'::json) FROM (SELECT migration_name,checksum,finished_at IS NOT NULL AS finished,rolled_back_at IS NOT NULL AS rolledback FROM \"_prisma_migrations\") m"))
 check(len(history)==len(expected) and {x['migration_name']:x['checksum'] for x in history}==expected and all(x['finished'] and not x['rolledback'] for x in history),'migration-history-drift')
 check(all(x==0 for x in owners().values()),'final-object-owner-drift')
 pins=json.loads(sql("SELECT json_agg(json_build_object('name',proname,'config',proconfig)) FROM pg_proc WHERE pronamespace='sho_pr9_scoped4'::regnamespace AND proname IN ('enforce_max_sections','enforce_task_section_in_project')"))
 check(len(pins)==2 and all(any(v.startswith('search_path=') and v.split('=',1)[1].replace('"','').strip()==SCHEMA for v in (x['config'] or [])) for x in pins),'trigger-search-path-drift')
 sql('BEGIN; CREATE TABLE "_scoped4_permission_probe"(id int PRIMARY KEY); INSERT INTO "_scoped4_permission_probe" VALUES (1); UPDATE "_scoped4_permission_probe" SET id=2; ALTER TABLE "_scoped4_permission_probe" ADD COLUMN note text; DELETE FROM "_scoped4_permission_probe"; DROP TABLE "_scoped4_permission_probe"; ROLLBACK;')
 prisma(['migrate','status'],'migrate-status')
 check(metadata()==before and sql("SELECT oid FROM pg_namespace WHERE nspname='sho_pr9_scoped4'")==oid,'outside-catalog-or-oid-drift')
 check(files=={p.parent.name:h(p) for p in (release/'prisma/migrations').glob('*/migration.sql')},'migration-files-modified')
 result={'ok':True,'candidateSHA':SHA,'schema':SCHEMA,'schemaOID':oid,'schemaOwner':'doadmin','applicationObjectOwner':ROLE,'migrations':len(history),'canonicalHistoryChecksumsMatch':True,'migrationFilesUnchanged':True,'databaseCreate':False,'initialPublicNoopPreSatisfied':True,'outsideCatalogUnchanged':True,'pinnedTriggerSearchPaths':True,'ownedDMLAndDDLProbeRolledBack':True,'productionTouched':False}
 save('result.json',result);print(json.dumps(result))
except Exception as e:
 result={'ok':False,'phase':phase,'errorType':type(e).__name__,'reason':str(e) if isinstance(e,Refusal) else 'setup-or-guard-failure','productionTouched':False,'noBlindResume':True}
 if work:
  try:save('failure-result-'+str(time.time_ns())+'.json',result)
  except Exception:pass
 print(json.dumps(result));raise SystemExit(1)
