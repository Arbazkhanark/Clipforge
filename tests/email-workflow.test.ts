// Email verification and password reset. The mock outbox is the only provider that accepts a message.
// A filled-in SMTP configuration does not connect to a provider. Persistence cases run only for the isolated local database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AuthService, DEFAULT_AUTH_CONFIG } from "../src/server/auth/auth-service.ts";
import type { UserRecord } from "../src/server/auth/auth-repository.ts";
import { MemoryEmailOutbox, createEmailSetup, createLazyEmailSetup } from "../src/server/auth/email.ts";
import { InMemoryRateLimiter } from "../src/server/auth/rate-limiter.ts";
import { MemoryAuthRepository } from "../src/server/auth/memory-auth-repository.ts";
import { AppError } from "../src/server/errors.ts";
import { createPrismaClient } from "../src/server/prisma/create-client.ts";
import { PrismaAuthRepository } from "../src/server/prisma/prisma-auth-repository.ts";
import type { PrismaClientLike } from "../src/server/prisma/prisma-client-like.ts";
import type { EmailSender } from "../src/server/auth/email.ts";
import { isolatedDatabaseUrl } from "./helpers/isolated-database.ts";

const FAST = { logN: 10, r: 8, p: 1 };
const PASSWORD = "a real database password";
const NEXT = "a different database password";
const databaseUrlAtStart = isolatedDatabaseUrl();
const hasDatabase = Boolean(databaseUrlAtStart);
const tokenFrom = (text: string): string => new URL(text.match(/https?:\/\/\S+/)![0]!).searchParams.get("token")!;

test("email delivery is disabled by default and SES setup is deferred until an enabled send", async () => {
  const disabled = createLazyEmailSetup({ NODE_ENV: "production", EMAIL_PROVIDER: "invalid", EMAIL_FROM: "invalid" }, false);
  assert.equal(disabled.delivery, "unavailable");
  await assert.rejects(() => disabled.sender.send({ to: "user@example.test", subject: "x", text: "x" }), (error: unknown) => error instanceof AppError && error.code === "email_not_configured");

  const invalidButLazy = createLazyEmailSetup({ NODE_ENV: "production", CLIPFORGE_DEPLOYMENT_ENV: "production", EMAIL_PROVIDER: "ses" }, true);
  assert.equal(invalidButLazy.delivery, "unavailable");
  await assert.rejects(() => invalidButLazy.sender.send({ to: "user@example.test", subject: "x", text: "x" }), /Email provider configuration is invalid/);
  const productionFake = createLazyEmailSetup({ NODE_ENV: "production", CLIPFORGE_DEPLOYMENT_ENV: "production", EMAIL_PROVIDER: "fake" }, true);
  assert.equal(productionFake.delivery, "unavailable");
  await assert.rejects(() => productionFake.sender.send({ to: "user@example.test", subject: "x", text: "x" }), /Email provider configuration is invalid/);

  let credentialsResolved = 0;
  let requests = 0;
  const configured = createLazyEmailSetup({ NODE_ENV: "production", CLIPFORGE_DEPLOYMENT_ENV: "production", EMAIL_PROVIDER: "ses", AWS_REGION: "ap-south-1", EMAIL_FROM: "mail@example.test" }, true, {
    resolveAwsCredentials: async () => { credentialsResolved++; return { accessKeyId: "synthetic-access", secretAccessKey: "synthetic-secret" }; },
    fetch: async () => { requests++; return new Response(null, { status: 200 }); },
  });
  assert.equal(credentialsResolved, 0);
  assert.equal(requests, 0);
  await configured.sender.send({ to: "user@example.test", subject: "x", text: "x" });
  assert.equal(credentialsResolved, 1);
  assert.equal(requests, 1);
});

function service(repo: MemoryAuthRepository | PrismaAuthRepository, email: EmailSender, opts: { limiter?: InMemoryRateLimiter; now?: () => Date; requireVerifiedEmail?: boolean } = {}) {
  return new AuthService({
    repo, email, limiter: opts.limiter ?? new InMemoryRateLimiter(), now: opts.now ?? (() => new Date()), newId: () => randomUUID(),
    config: { ...DEFAULT_AUTH_CONFIG("http://localhost:3000"), scrypt: FAST, requireVerifiedEmail: opts.requireVerifiedEmail ?? true },
  });
}

class TrackingPrismaAuthRepository extends PrismaAuthRepository {
  constructor(
    private readonly client: PrismaClientLike,
    private readonly ownedUserIds: Set<string>,
  ) {
    super(client);
  }

  override async createUser(user: UserRecord): Promise<boolean> {
    const created = await super.createUser(user);
    if (!created) return false;

    const persisted = await this.client.user.findUnique({ where: { id: user.id }, select: { id: true, email: true } });
    if (persisted?.["id"] === user.id && persisted["email"] === user.email) this.ownedUserIds.add(user.id);
    return true;
  }
}

test("provider selection enforces environment policy and preserves development SMTP", async () => {
  assert.equal(createEmailSetup({ NODE_ENV: "development" }).delivery, "unavailable");
  assert.equal(createEmailSetup({ NODE_ENV: "development" }).requireVerifiedEmail, false);
  const outbox = createEmailSetup({ NODE_ENV: "development", CLIPFORGE_EMAIL_PROVIDER: "outbox" });
  assert.equal(outbox.delivery, "outbox");
  assert.equal(outbox.requireVerifiedEmail, true);
  assert.throws(() => createEmailSetup({ CLIPFORGE_EMAIL_PROVIDER: "outbox", NODE_ENV: "production" }), /configuration is invalid/);
  let transportOptions: Record<string, unknown> | undefined;
  let sent: unknown;
  const smtp = createEmailSetup({ NODE_ENV: "development", EMAIL_PROVIDER: "nodemailer", SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "mailer", SMTP_PASS: "synthetic-mail-secret", EMAIL_FROM: "ClipForge <mailer@example.com>" }, {
    createSmtpTransport: (options) => { transportOptions = options; return { sendMail: async (message) => { sent = message; } }; },
  });
  assert.equal(smtp.delivery, "nodemailer");
  assert.equal(smtp.requireVerifiedEmail, true);
  assert.deepEqual(transportOptions?.["tls"], { minVersion: "TLSv1.2" });
  assert.equal(transportOptions?.["requireTLS"], true);
  await smtp.sender.send({ to: "ann@example.com", subject: "Confirm", text: "hidden" });
  assert.equal((sent as { from?: string }).from, "ClipForge <mailer@example.com>");
  const locallyLoadedSmtp = createEmailSetup({ NODE_ENV: "development", EMAIL_PROVIDER: "nodemailer", SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "mailer", SMTP_PASS: "synthetic-mail-secret", EMAIL_FROM: "mailer@example.com" });
  assert.equal(locallyLoadedSmtp.delivery, "nodemailer", "development can load the installed devDependency without sending mail");
  assert.equal(createEmailSetup({ NODE_ENV: "development", EMAIL_PROVIDER: "ses", AWS_REGION: "ap-south-1", EMAIL_FROM: "mail@example.com" }).delivery, "unavailable");
});

test("test environment always uses an in-memory fake and refuses real provider selection", async () => {
  const setup = createEmailSetup({ NODE_ENV: "test" });
  assert.equal(setup.delivery, "outbox");
  await setup.sender.send({ to: "sample@example.test", subject: "test", text: "synthetic" });
  assert.equal(setup.outbox?.messages.length, 1);
  assert.equal(createEmailSetup({ NODE_ENV: "test", EMAIL_PROVIDER: "ses" }).configurationError, "provider_environment_mismatch");
  assert.equal(createEmailSetup({ NODE_ENV: "test", CLIPFORGE_EMAIL_PROVIDER: "smtp" }).configurationError, "provider_environment_mismatch");
});

test("production requires valid SES configuration and rejects SMTP, outbox, missing provider, and static AWS keys", async () => {
  const production = { NODE_ENV: "production", CLIPFORGE_DEPLOYMENT_ENV: "production" };
  for (const env of [
    production,
    { ...production, EMAIL_PROVIDER: "nodemailer" },
    { ...production, EMAIL_PROVIDER: "outbox" },
    { ...production, CLIPFORGE_EMAIL_PROVIDER: "outbox" },
    { ...production, EMAIL_PROVIDER: "ses", AWS_REGION: "ap-south-1", EMAIL_FROM: "from@example.com", AWS_ACCESS_KEY_ID: "synthetic", AWS_SECRET_ACCESS_KEY: "synthetic" },
    { ...production, EMAIL_PROVIDER: "ses", AWS_REGION: "bad-region", EMAIL_FROM: "from@example.com" },
  ]) {
    assert.throws(() => createEmailSetup(env), /Email provider configuration is invalid/);
  }
  assert.throws(() => createEmailSetup({ ...production, EMAIL_PROVIDER: "ses", AWS_REGION: "ap-south-1" }), /Email provider configuration is invalid/);
  assert.throws(() => createEmailSetup({ ...production, EMAIL_PROVIDER: "ses", CLIPFORGE_EMAIL_PROVIDER: "smtp", AWS_REGION: "ap-south-1", EMAIL_FROM: "from@example.com" }), /Email provider configuration is invalid/);
  let smtpFactoryCalls = 0;
  assert.throws(() => createEmailSetup({ ...production, EMAIL_PROVIDER: "nodemailer" }, {
    createSmtpTransport: () => { smtpFactoryCalls += 1; return { sendMail: async () => undefined }; },
  }), /Email provider configuration is invalid/);
  assert.equal(smtpFactoryCalls, 0, "production policy must reject SMTP before attempting to load or initialize Nodemailer");
});

test("staging defaults to fake delivery and restricts SES to a valid recipient allowlist", async () => {
  const staging = { NODE_ENV: "production", CLIPFORGE_DEPLOYMENT_ENV: "staging" };
  assert.equal(createEmailSetup(staging).delivery, "outbox");
  let sends = 0;
  const valid = createEmailSetup({ ...staging, EMAIL_PROVIDER: "ses", AWS_REGION: "ap-south-2", EMAIL_FROM: "mail@example.com", CLIPFORGE_EMAIL_RECIPIENT_ALLOWLIST: "Ann@example.com, ops@example.test" }, {
    resolveAwsCredentials: async () => ({ accessKeyId: "synthetic-access", secretAccessKey: "synthetic-secret" }),
    fetch: async () => { sends += 1; return new Response(null, { status: 200 }); },
  });
  assert.equal(valid.delivery, "ses");
  await valid.sender.send({ to: "ann@example.com", subject: "test", text: "synthetic" });
  assert.equal(sends, 1);
  await assert.rejects(() => valid.sender.send({ to: "outside@example.com", subject: "test", text: "synthetic" }), (error: unknown) => error instanceof AppError && error.code === "email_delivery_failed");
  assert.equal(sends, 1, "blocked recipient never reaches SES transport");
  for (const allowlist of [undefined, "", "bad-entry", "good@example.com,"]) {
    const rejected = createEmailSetup({ ...staging, EMAIL_PROVIDER: "ses", AWS_REGION: "ap-south-2", EMAIL_FROM: "mail@example.com", ...(allowlist === undefined ? {} : { CLIPFORGE_EMAIL_RECIPIENT_ALLOWLIST: allowlist }) });
    assert.equal(rejected.delivery, "unavailable");
    assert.equal(rejected.configurationError, "staging_recipient_allowlist_invalid");
  }
  assert.equal(createEmailSetup({ ...staging, EMAIL_PROVIDER: "nodemailer" }).configurationError, "provider_environment_mismatch");
});

test("provider aliases reject conflicting EMAIL_PROVIDER and CLIPFORGE_EMAIL_PROVIDER values", () => {
  const setup = createEmailSetup({ NODE_ENV: "development", EMAIL_PROVIDER: "nodemailer", CLIPFORGE_EMAIL_PROVIDER: "ses" });
  assert.equal(setup.delivery, "unavailable");
  assert.equal(setup.configurationError, "provider_environment_mismatch");
  const aliases = createEmailSetup({ NODE_ENV: "development", EMAIL_PROVIDER: "nodemailer", CLIPFORGE_EMAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "user", SMTP_PASS: "synthetic", EMAIL_FROM: "from@example.com" }, {
    createSmtpTransport: () => ({ sendMail: async () => undefined }),
  });
  assert.equal(aliases.delivery, "nodemailer");
});

test("SES provider selection sends only through the selected adapter and does not expose credentials", async () => {
  let url = ""; let requestInit: RequestInit | undefined;
  const ses = createEmailSetup({ NODE_ENV: "production", CLIPFORGE_DEPLOYMENT_ENV: "production", EMAIL_PROVIDER: "ses", AWS_REGION: "ap-south-1", EMAIL_FROM: "ClipForge <mail@example.com>" }, {
    resolveAwsCredentials: async () => ({ accessKeyId: "synthetic-access", secretAccessKey: "synthetic-secret" }),
    fetch: async (input, init) => { url = String(input); requestInit = init; return new Response(null, { status: 200 }); },
    now: () => new Date("2026-11-13T00:00:00Z"),
  });
  assert.equal(ses.delivery, "ses");
  assert.equal(ses.requireVerifiedEmail, true);
  await ses.sender.send({ to: "ann@example.com", subject: "Verify", text: "synthetic message" });
  assert.equal(url, "https://email.ap-south-1.amazonaws.com/v2/email/outbound-emails");
  assert.equal((requestInit?.headers as Record<string, string>)["authorization"]?.includes("synthetic-secret"), false);
});

test("SES accepts a lazy task-role credential provider and signs temporary credentials", async () => {
  let resolved = 0;
  let requestInit: RequestInit | undefined;
  const ses = createEmailSetup({ NODE_ENV: "production", CLIPFORGE_DEPLOYMENT_ENV: "production", EMAIL_PROVIDER: "ses", AWS_REGION: "ap-south-2", EMAIL_FROM: "mail@example.com" }, {
    resolveAwsCredentials: async () => {
      resolved += 1;
      return { accessKeyId: "synthetic-task-access", secretAccessKey: "synthetic-task-secret", sessionToken: "synthetic-task-session" };
    },
    fetch: async (_input, init) => { requestInit = init; return new Response(null, { status: 200 }); },
    now: () => new Date("2026-11-13T00:00:00Z"),
  });
  assert.equal(ses.delivery, "ses");
  assert.equal(resolved, 0, "configuration does not contact metadata or resolve credentials");
  await ses.sender.send({ to: "ann@example.com", subject: "Verify", text: "synthetic message" });
  assert.equal(resolved, 1);
  const headers = requestInit?.headers as Record<string, string>;
  assert.equal(headers["x-amz-security-token"], "synthetic-task-session");
  assert.match(headers.authorization ?? "", /^AWS4-HMAC-SHA256 Credential=synthetic-task-access\//);
  assert.doesNotMatch(headers.authorization ?? "", /synthetic-task-secret|synthetic-task-session/);
});

test("SES rejects partial static credentials and does not reveal provider errors", async () => {
  for (const env of [
    { NODE_ENV: "production", CLIPFORGE_DEPLOYMENT_ENV: "staging", EMAIL_PROVIDER: "ses", AWS_REGION: "ap-south-2", AWS_ACCESS_KEY_ID: "partial", EMAIL_FROM: "mail@example.com", CLIPFORGE_EMAIL_RECIPIENT_ALLOWLIST: "ann@example.com" },
    { NODE_ENV: "production", CLIPFORGE_DEPLOYMENT_ENV: "staging", EMAIL_PROVIDER: "ses", AWS_REGION: "ap-south-2", AWS_SECRET_ACCESS_KEY: "partial", EMAIL_FROM: "mail@example.com", CLIPFORGE_EMAIL_RECIPIENT_ALLOWLIST: "ann@example.com" },
    { NODE_ENV: "production", CLIPFORGE_DEPLOYMENT_ENV: "staging", EMAIL_PROVIDER: "ses", AWS_REGION: "ap-south-2", AWS_SESSION_TOKEN: "partial", EMAIL_FROM: "mail@example.com", CLIPFORGE_EMAIL_RECIPIENT_ALLOWLIST: "ann@example.com" },
  ]) {
    const setup = createEmailSetup(env);
    assert.equal(setup.delivery, "unavailable");
    assert.equal(setup.configurationError, "ses_credentials_missing");
  }
  const ses = createEmailSetup({ NODE_ENV: "production", CLIPFORGE_DEPLOYMENT_ENV: "production", EMAIL_PROVIDER: "ses", AWS_REGION: "ap-south-2", EMAIL_FROM: "mail@example.com" }, {
    resolveAwsCredentials: async () => { throw new Error("metadata response contains a synthetic secret"); },
  });
  await assert.rejects(() => ses.sender.send({ to: "ann@example.com", subject: "x", text: "y" }), (error: unknown) =>
    error instanceof AppError && error.code === "email_delivery_failed" && !error.message.includes("synthetic secret"));
});

test("missing SES or SMTP fields produce a fixed configuration error without revealing values", async () => {
  const ses = createEmailSetup({ NODE_ENV: "production", CLIPFORGE_DEPLOYMENT_ENV: "staging", EMAIL_PROVIDER: "ses", AWS_REGION: "ap-south-1", AWS_ACCESS_KEY_ID: "present", CLIPFORGE_EMAIL_RECIPIENT_ALLOWLIST: "ann@example.com" });
  assert.equal(ses.delivery, "unavailable");
  assert.equal(ses.configurationError, "ses_credentials_missing");
  const smtp = createEmailSetup({ NODE_ENV: "development", EMAIL_PROVIDER: "nodemailer", SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "present", SMTP_PASS: "present" });
  assert.equal(smtp.delivery, "unavailable");
  assert.equal(smtp.configurationError, "smtp_configuration_invalid");
  assert.equal(smtp.sender instanceof Object, true);
});

test("provider delivery failures return a fixed error with no SMTP or SES response details", async () => {
  const smtp = createEmailSetup({ NODE_ENV: "development", EMAIL_PROVIDER: "nodemailer", SMTP_HOST: "smtp.private.example", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "private-user", SMTP_PASS: "synthetic-password", EMAIL_FROM: "from@example.com" }, {
    createSmtpTransport: () => ({ sendMail: async () => { throw new Error("private SMTP response and password"); } }),
  });
  await assert.rejects(() => smtp.sender.send({ to: "to@example.com", subject: "x", text: "y" }), (error: unknown) => error instanceof AppError && error.code === "email_delivery_failed" && !error.message.includes("private SMTP"));
  const ses = createEmailSetup({ NODE_ENV: "production", CLIPFORGE_DEPLOYMENT_ENV: "production", EMAIL_PROVIDER: "ses", AWS_REGION: "ap-south-1", EMAIL_FROM: "from@example.com" }, {
    resolveAwsCredentials: async () => ({ accessKeyId: "synthetic-key", secretAccessKey: "synthetic-secret" }),
    fetch: async () => new Response("sensitive provider body", { status: 403 }), now: () => new Date("2026-11-13T00:00:00Z"),
  });
  await assert.rejects(() => ses.sender.send({ to: "to@example.com", subject: "x", text: "y" }), (error: unknown) => error instanceof AppError && error.code === "email_delivery_failed" && !error.message.includes("sensitive"));
});

test("a failed send stores no usable verification token", async () => {
  const repo = new MemoryAuthRepository();
  const failing: EmailSender = { async send() { throw new AppError(503, "email_not_configured", "Email delivery is not configured. No message was sent."); } };
  const auth = service(repo, failing);
  await assert.rejects(() => auth.register({ email: "ann@example.com", password: PASSWORD }), (error: unknown) => error instanceof AppError && error.code === "email_not_configured");
  const user = await repo.getUserByEmail("ann@example.com");
  assert.equal(user?.emailVerifiedAt, null);
  assert.deepEqual(await auth.verifyEmail("a".repeat(32)), { ok: false });
  assert.equal((await auth.login({ email: "ann@example.com", password: PASSWORD })).ok, false);
});

test("reset requests and repeated bad links are rate limited without revealing accounts", async () => {
  const repo = new MemoryAuthRepository();
  const outbox = new MemoryEmailOutbox();
  const limiter = new InMemoryRateLimiter(2, 60_000, 60_000);
  const auth = service(repo, outbox, { limiter });
  await auth.register({ email: "ann@example.com", password: PASSWORD });
  assert.deepEqual(await auth.verifyEmail(tokenFrom(outbox.messages.at(-1)!.text)), { ok: true });
  const before = outbox.messages.length;
  assert.deepEqual(await auth.requestPasswordReset("ghost@example.com"), { ok: true });
  assert.equal(outbox.messages.length, before);
  assert.deepEqual(await auth.requestPasswordReset("ann@example.com"), { ok: true });
  assert.deepEqual(await auth.requestPasswordReset("ann@example.com"), { ok: true });
  const limited = outbox.messages.length;
  assert.deepEqual(await auth.requestPasswordReset("ann@example.com"), { ok: true });
  assert.equal(outbox.messages.length, limited);

  const clock = { now: new Date("2026-11-06T12:00:00Z") };
  const links = new MemoryAuthRepository();
  const box = new MemoryEmailOutbox();
  const limitedAuth = service(links, box, { limiter: new InMemoryRateLimiter(2, 60_000, 60_000), now: () => clock.now });
  await limitedAuth.register({ email: "bea@example.com", password: PASSWORD });
  const token = tokenFrom(box.messages.at(-1)!.text);
  clock.now = new Date(clock.now.getTime() + 25 * 3_600_000);
  assert.deepEqual(await limitedAuth.verifyEmail(token), { ok: false });
  assert.deepEqual(await limitedAuth.verifyEmail(token), { ok: false });
  clock.now = new Date("2026-11-06T12:00:00Z");
  assert.deepEqual(await limitedAuth.verifyEmail(token), { ok: false });
});

test("test fake provider preserves registration, resend verification, and password-reset delivery flows", async () => {
  const repo = new MemoryAuthRepository();
  const setup = createEmailSetup({ NODE_ENV: "test" });
  const auth = service(repo, setup.sender);
  await auth.register({ email: "resend@example.test", password: PASSWORD });
  const firstToken = tokenFrom(setup.outbox!.messages[0]!.text);
  await auth.resendVerification("resend@example.test");
  const resentToken = tokenFrom(setup.outbox!.messages[1]!.text);
  assert.notEqual(firstToken, resentToken);
  assert.deepEqual(await auth.verifyEmail(firstToken), { ok: false });
  assert.deepEqual(await auth.verifyEmail(resentToken), { ok: true });
  await auth.requestPasswordReset("resend@example.test");
  assert.match(setup.outbox!.messages[2]!.subject, /Reset/);
  assert.ok(tokenFrom(setup.outbox!.messages[2]!.text));
});

test("verification and password reset survive a new database connection", { skip: hasDatabase ? false : "DATABASE_URL is not set for this process" }, async () => {
  const email = `phase4-${randomUUID()}@clipforge.test`;
  const ownedUserIds = new Set<string>();
  const openClients = new Set<PrismaClientLike & { $disconnect(): Promise<void> }>();
  const outbox = new MemoryEmailOutbox();
  const clock = { now: new Date("2026-11-06T12:00:00Z") };
  const open = async () => {
    const db = await createPrismaClient(databaseUrlAtStart as string);
    const client = db as PrismaClientLike & { $disconnect(): Promise<void> };
    openClients.add(client);
    return { db, auth: service(new TrackingPrismaAuthRepository(client, ownedUserIds), outbox, { now: () => clock.now }) };
  };
  const disconnect = async (client: PrismaClientLike & { $disconnect(): Promise<void> }) => {
    try { await client.$disconnect(); }
    finally { openClients.delete(client); }
  };
  try {
    const first = await open();
    assert.deepEqual(await first.auth.register({ email, password: PASSWORD }), { ok: true });
    const verification = tokenFrom(outbox.messages.at(-1)!.text);
    assert.equal(outbox.messages.at(-1)!.text.includes(verification), true);
    await disconnect(first.db as PrismaClientLike & { $disconnect(): Promise<void> });

    const second = await open();
    try {
      assert.deepEqual(await second.auth.verifyEmail(verification), { ok: true });
      assert.deepEqual(await second.auth.verifyEmail(verification), { ok: false });
      const user = await second.db.user.findUnique({ where: { email } });
      assert.ok(user && user["emailVerified"] instanceof Date);
      const login = await second.auth.login({ email, password: PASSWORD });
      assert.equal(login.ok, true);
      if (!login.ok) return;
      assert.equal(await second.auth.getSessionUserId(login.sessionToken), login.userId);
      const before = outbox.messages.length;
      assert.deepEqual(await second.auth.requestPasswordReset("nobody-" + email), { ok: true });
      assert.equal(outbox.messages.length, before);
      await second.auth.requestPasswordReset(email);
      const reset = tokenFrom(outbox.messages.at(-1)!.text);
      await disconnect(second.db as PrismaClientLike & { $disconnect(): Promise<void> });

      const third = await open();
      try {
        assert.deepEqual(await third.auth.resetPassword(reset, "short"), { ok: false, problems: ["Password must be at least 10 characters."] });
        assert.deepEqual(await third.auth.resetPassword(reset, NEXT), { ok: true });
        assert.equal((await third.auth.resetPassword(reset, NEXT)).ok, false);
        assert.equal(await third.auth.getSessionUserId(login.sessionToken), null);
        assert.equal((await third.auth.login({ email, password: PASSWORD })).ok, false);
        assert.equal((await third.auth.login({ email, password: NEXT })).ok, true);
        const otherEmail = `phase4-other-${randomUUID()}@clipforge.test`;
        assert.deepEqual(await third.auth.register({ email: otherEmail, password: PASSWORD }), { ok: true });
        const otherToken = tokenFrom(outbox.messages.at(-1)!.text);
        assert.deepEqual(await third.auth.verifyEmail(otherToken), { ok: true });
        const owner = await third.db.user.findUnique({ where: { email } });
        const stranger = await third.db.user.findUnique({ where: { email: otherEmail } });
        assert.ok(owner && stranger);
        assert.notEqual(owner.id, stranger.id);
        assert.ok(stranger.emailVerified instanceof Date);
      } finally {
        await disconnect(third.db as PrismaClientLike & { $disconnect(): Promise<void> });
      }
    } finally { await disconnect(second.db as PrismaClientLike & { $disconnect(): Promise<void> }).catch(() => undefined); }
  } finally {
    try {
      if (ownedUserIds.size > 0) {
        const cleanup = await open();
        try {
          await cleanup.db.user.deleteMany({ where: { id: { in: [...ownedUserIds] } } });
        } finally {
          await disconnect(cleanup.db as PrismaClientLike & { $disconnect(): Promise<void> });
        }
      }
    } finally {
      for (const client of [...openClients]) await disconnect(client).catch(() => undefined);
    }
  }
});
