# Database roles

## Runtime versus migration identity

Sheet Happens Officer intentionally uses two PostgreSQL identities:

- `DATABASE_URL` is the long-running application connection. Production uses `sho_app`, a login role with `USAGE` on the application schema plus `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on its tables and `USAGE`, `SELECT`, and `UPDATE` on its sequences. It has no schema `CREATE`, superuser, database-creation, role-creation, inheritance, replication, or RLS-bypass rights.
- `DIRECT_DATABASE_URL` is the direct migration/admin connection. It remains `doadmin` because Prisma migrations need DDL rights and the existing production objects are owned by `doadmin`.

`doadmin` must not be used by the running application. It is reserved for managed-database administration and migrations.

## SHO-2687 staged rollout

The checked-in operator is `scripts/ops/sho-2687-apply.sh`. It never prints either URL or a password. The selected environment file and the password file must be root-only (`0600` or stricter). `apply` is idempotent and writes a root-only receipt. If validation fails after replacing the runtime environment, the previous environment file is restored automatically.

Run the same sequence against isolated staging first, using staging-specific files, role, service and health URL:

```sh
SHO_2687_ENV_FILE=/etc/sho-staging/db.env \
SHO_2687_APP_ROLE=sho_staging_app \
SHO_2687_SCHEMA=sho \
SHO_2687_SERVICE=sho-staging.service \
SHO_2687_RELEASE_ROOT=/opt/sho-staging \
SHO_2687_HEALTH_URL=http://127.0.0.1:3001/api/health \
SHO_2687_EXPECTED_RELEASE=<exact-staging-sha> \
SHO_2687_PASSWORD_FILE=/root/.secrets/sho-staging-app-password \
SHO_2687_BACKUP_FILE=/etc/sho-staging/db.env.sho-2687-backup \
SHO_2687_RECEIPT_FILE=/var/lib/sho/sho-2687-staging-receipt.json \
  scripts/ops/sho-2687-apply.sh apply
```

After the staging receipt, exact health response, application smoke tests, migration status, DML checks, DDL denial and rollback have been verified, run production with the explicit production approval and pinned release:

```sh
SHO_2687_ENV_FILE=/etc/sho/app.env \
SHO_2687_APP_ROLE=sho_app \
SHO_2687_SERVICE=sho.service \
SHO_2687_HEALTH_URL=http://127.0.0.1:3000/api/health \
SHO_2687_EXPECTED_RELEASE=<exact-production-sha> \
SHO_2687_PASSWORD_FILE=/root/.secrets/sho-app-password \
  scripts/ops/sho-2687-apply.sh apply
```

The rollback file path is included in the receipt. To roll back, restore that file over the selected environment file with mode `0600`, restart the selected service, and verify its exact release health. Do not remove `sho_app` during rollback; retaining a disabled or unused least-privilege role is safer than dropping a role that might own active sessions.
