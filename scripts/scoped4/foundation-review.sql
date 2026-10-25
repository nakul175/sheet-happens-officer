-- REVIEW ONLY: not executed. Fresh idle doadmin session connected to sho_staging.
-- If the previous scoped4 attempt left its own transaction aborted, end THAT
-- attempt first. Never rollback unrelated work automatically.
-- Foundation only: exact pinned Prisma init still needs separately reviewed bootstrap.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20s';
SET LOCAL search_path = pg_catalog;
DO $scoped4$
DECLARE
  before_existing jsonb;
  after_existing jsonb;
  app_oid oid;
  admin_oid oid;
  new_oid oid;
BEGIN
  IF current_database()<>'sho_staging' OR current_user<>'doadmin' OR session_user<>'doadmin' THEN
    RAISE EXCEPTION 'Requires an idle doadmin connection to sho_staging';
  END IF;
  IF current_setting('server_version_num')::int NOT BETWEEN 160000 AND 169999 THEN
    RAISE EXCEPTION 'Review is pinned to PostgreSQL 16';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sho_staging:sho_pr9_scoped4:reviewed-operation',0));
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='sho_pr9_scoped4') THEN
    RAISE EXCEPTION 'Target already exists: inspect it, do not reuse or alter it blindly';
  END IF;
  IF (SELECT count(*) FROM pg_namespace WHERE nspname IN ('public','sho_pr9'))<>2 THEN
    RAISE EXCEPTION 'Expected existing public and sho_pr9 schemas absent';
  END IF;
  SELECT oid INTO STRICT app_oid FROM pg_roles WHERE rolname='sho_slot_pr9_app';
  SELECT oid INTO STRICT admin_oid FROM pg_roles WHERE rolname='doadmin';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE oid=app_oid AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR NOT rolcanlogin)) THEN
    RAISE EXCEPTION 'Unexpected application role attributes';
  END IF;
  IF has_database_privilege(app_oid,current_database(),'CREATE') OR pg_has_role(app_oid,admin_oid,'MEMBER') THEN
    RAISE EXCEPTION 'App role unexpectedly has database CREATE or admin membership';
  END IF;
  IF NOT has_database_privilege(admin_oid,current_database(),'CREATE') THEN
    RAISE EXCEPTION 'Admin lacks schema creation privilege';
  END IF;
  SELECT jsonb_build_object(
    'schemas', (SELECT coalesce(jsonb_agg(jsonb_build_array(n.oid,n.nspname,n.nspowner,n.nspacl::text) ORDER BY n.oid),'[]'::jsonb) FROM pg_namespace n WHERE n.nspname IN ('public','sho_pr9')),
    'relations', (SELECT coalesce(jsonb_agg(jsonb_build_array(c.oid,c.relname,c.relkind,c.relowner,c.relacl::text) ORDER BY c.oid),'[]'::jsonb) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','sho_pr9')),
    'functions', (SELECT coalesce(jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl::text,p.proconfig) ORDER BY p.oid),'[]'::jsonb) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','sho_pr9')),
    'types', (SELECT coalesce(jsonb_agg(jsonb_build_array(t.oid,t.typowner,t.typacl::text) ORDER BY t.oid),'[]'::jsonb) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname IN ('public','sho_pr9')),
    'database_acl', (SELECT jsonb_build_array(datdba,datacl::text) FROM pg_database WHERE datname=current_database()),
    'app_role', (SELECT jsonb_build_array(oid,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconfig) FROM pg_roles WHERE rolname='sho_slot_pr9_app'),
    'memberships', (SELECT coalesce(jsonb_agg(jsonb_build_array(m.roleid,m.member,m.grantor,m.admin_option,m.inherit_option,m.set_option) ORDER BY m.roleid,m.member,m.grantor),'[]'::jsonb) FROM pg_auth_members m WHERE m.roleid=(SELECT oid FROM pg_roles WHERE rolname='sho_slot_pr9_app') OR m.member=(SELECT oid FROM pg_roles WHERE rolname='sho_slot_pr9_app'))
  ) INTO before_existing;
  CREATE SCHEMA sho_pr9_scoped4 AUTHORIZATION doadmin;
  REVOKE ALL ON SCHEMA sho_pr9_scoped4 FROM PUBLIC;
  GRANT USAGE, CREATE ON SCHEMA sho_pr9_scoped4 TO sho_slot_pr9_app;
  SELECT oid INTO STRICT new_oid FROM pg_namespace WHERE nspname='sho_pr9_scoped4' AND nspowner=admin_oid;
  IF NOT has_schema_privilege(app_oid,new_oid,'USAGE') OR NOT has_schema_privilege(app_oid,new_oid,'CREATE')
     OR has_schema_privilege(app_oid,new_oid,'USAGE WITH GRANT OPTION')
     OR has_schema_privilege(app_oid,new_oid,'CREATE WITH GRANT OPTION') THEN
    RAISE EXCEPTION 'App schema privileges do not match the exact bounded grant';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
             WHERE n.oid=new_oid AND (a.grantee NOT IN (admin_oid,app_oid) OR a.grantor<>admin_oid
               OR a.privilege_type NOT IN ('USAGE','CREATE') OR (a.grantee=app_oid AND a.is_grantable))) THEN
    RAISE EXCEPTION 'Unexpected schema grantee, grantor, privilege, or delegation';
  END IF;
  IF (SELECT count(*) FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
      WHERE n.oid=new_oid AND a.grantee=app_oid)<>2 THEN
    RAISE EXCEPTION 'Expected exactly two app schema privilege entries';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relnamespace=new_oid)
     OR EXISTS (SELECT 1 FROM pg_type WHERE typnamespace=new_oid)
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace=new_oid) THEN
    RAISE EXCEPTION 'New schema is not empty';
  END IF;
  SELECT jsonb_build_object(
    'schemas', (SELECT coalesce(jsonb_agg(jsonb_build_array(n.oid,n.nspname,n.nspowner,n.nspacl::text) ORDER BY n.oid),'[]'::jsonb) FROM pg_namespace n WHERE n.nspname IN ('public','sho_pr9')),
    'relations', (SELECT coalesce(jsonb_agg(jsonb_build_array(c.oid,c.relname,c.relkind,c.relowner,c.relacl::text) ORDER BY c.oid),'[]'::jsonb) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','sho_pr9')),
    'functions', (SELECT coalesce(jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl::text,p.proconfig) ORDER BY p.oid),'[]'::jsonb) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','sho_pr9')),
    'types', (SELECT coalesce(jsonb_agg(jsonb_build_array(t.oid,t.typowner,t.typacl::text) ORDER BY t.oid),'[]'::jsonb) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname IN ('public','sho_pr9')),
    'database_acl', (SELECT jsonb_build_array(datdba,datacl::text) FROM pg_database WHERE datname=current_database()),
    'app_role', (SELECT jsonb_build_array(oid,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconfig) FROM pg_roles WHERE rolname='sho_slot_pr9_app'),
    'memberships', (SELECT coalesce(jsonb_agg(jsonb_build_array(m.roleid,m.member,m.grantor,m.admin_option,m.inherit_option,m.set_option) ORDER BY m.roleid,m.member,m.grantor),'[]'::jsonb) FROM pg_auth_members m WHERE m.roleid=(SELECT oid FROM pg_roles WHERE rolname='sho_slot_pr9_app') OR m.member=(SELECT oid FROM pg_roles WHERE rolname='sho_slot_pr9_app'))
  ) INTO after_existing;
  IF before_existing IS DISTINCT FROM after_existing OR has_database_privilege(app_oid,current_database(),'CREATE') THEN
    RAISE EXCEPTION 'Existing schemas, role, memberships or database privileges changed';
  END IF;
END $scoped4$;
SELECT n.oid AS schema_oid,n.nspname AS schema_name,pg_get_userbyid(n.nspowner) AS schema_owner,
       has_schema_privilege('sho_slot_pr9_app',n.oid,'USAGE') AS app_usage,
       has_schema_privilege('sho_slot_pr9_app',n.oid,'CREATE') AS app_create,
       has_database_privilege('sho_slot_pr9_app',current_database(),'CREATE') AS app_database_create,
       (SELECT count(*) FROM pg_class WHERE relnamespace=n.oid) AS relations,
       n.nspacl::text AS schema_acl
FROM pg_namespace n WHERE n.nspname='sho_pr9_scoped4';
COMMIT;
