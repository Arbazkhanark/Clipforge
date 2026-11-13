# First Admin provisioning (operator-only)

First Admin creation is performed only by `scripts/seed-first-admin.ts` from an interactive local terminal. The public `/admin/register` and `/api/admin/verify-email` flows have been removed. `POST /api/admin/bootstrap` returns HTTP 410 and cannot create accounts.

The operator enters an email address and password in the terminal. The password is entered with terminal echo disabled (mask characters only), checked against the existing password policy, and hashed with the same scrypt implementation used by ClipForge authentication. The plaintext password is not written to logs or the database. The user is created as `UserRole.admin` with `emailVerified` set to the current time, plus an audit row in the same transaction. Existing accounts are never promoted by this seed command. Admin login continues through `/admin/login` and the existing role and verification checks.

## Safety gates

The script reads `DIRECT_URL` from the process environment. It does not load dotenv files itself. Use Node `--env-file` explicitly and unset inherited URL overrides so the inspected file supplies the target. Before a write, the script:

1. Requires `ADMIN_SEED_EXPECTED_TARGET` to match the parsed `host:port/database` exactly.
2. Requires `ADMIN_SEED_ALLOW_REMOTE=true` for remote targets.
3. Connects and checks the connected database name and schema against the URL target.
4. Prints the target identifiers, asks for the email and password, then requires typing the exact confirmation phrase `CREATE FIRST ADMIN <email> ON <host:port/database>`.
5. Acquires the shared transaction advisory lock, checks that there are no Admins and no existing account with that email, then creates the user and audit record atomically.

The script does not send email and does not require `ADMIN_BOOTSTRAP_SECRET`, `ADMIN_BOOTSTRAP_EMAIL`, SMTP, or SES. Do not put the password in shell arguments or environment variables.

## Safe target preview

From the repository root, this prints the candidate host, port, and database but makes no database connection:

```sh
env -u DATABASE_URL -u DIRECT_URL node --env-file=.env.local --import tsx scripts/seed-first-admin.ts --inspect-target
```

Independently verify that displayed target in the database provider dashboard before proceeding. If your approved database config is in `.env` instead, substitute that filename. Never paste connection strings into chat.

## Provision after reviewing the target

Replace `<verified-host>:<port>/<database>` with the exact previewed target. For Neon, explicitly allow remote access; for local development, omit the allow flag. This command connects, verifies database/schema identity, and then prompts for credentials and the target confirmation phrase:

```sh
ADMIN_SEED_EXPECTED_TARGET='<verified-host>:<port>/<database>' ADMIN_SEED_ALLOW_REMOTE=true env -u DATABASE_URL -u DIRECT_URL node --env-file=.env.local --import tsx scripts/seed-first-admin.ts
```

Do not run the provisioning command until you have verified the target and reviewed the phrase. If an Admin already exists, the transaction refuses without creating another. The command creates no session; sign in afterward at `/admin/login` and open `/admin`.

## Migration note

The existing `AdminRegistration` Prisma model and migration are retained as immutable migration history, but this CLI no longer reads that model or table. The seed flow therefore does not depend on email verification records or the Admin registration migration. No migration was applied or modified by this change. This implementation and its tests do not verify a real PostgreSQL connection or production database behavior.
