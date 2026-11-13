// Email verification and password reset. The mock outbox is the only provider that accepts a message.
// A filled-in SMTP configuration does not connect to a provider. Persistence cases run only for the isolated local database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AuthService, DEFAULT_AUTH_CONFIG } from "../src/server/auth/auth-service.ts";
import { MemoryEmailOutbox, createEmailSetup } from "../src/server/auth/email.ts";
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

function service(repo: MemoryAuthRepository | PrismaAuthRepository, email: EmailSender, opts: { limiter?: InMemoryRateLimiter; now?: () => Date; requireVerifiedEmail?: boolean } = {}) {
  return new AuthService({
    repo, email, limiter: opts.limiter ?? new InMemoryRateLimiter(), now: opts.now ?? (() => new Date()), newId: () => randomUUID(),
    config: { ...DEFAULT_AUTH_CONFIG("http://localhost:3000"), scrypt: FAST, requireVerifiedEmail: opts.requireVerifiedEmail ?? true },
  });
}

test("provider selection preserves the development outbox and initializes only configured providers", async () => {
  assert.equal(createEmailSetup({}).delivery, "unavailable");
  assert.equal(createEmailSetup({}).requireVerifiedEmail, false);
  const outbox = createEmailSetup({ CLIPFORGE_EMAIL_PROVIDER: "outbox" });
  assert.equal(outbox.delivery, "outbox");
  assert.equal(outbox.requireVerifiedEmail, true);
  assert.equal(createEmailSetup({ CLIPFORGE_EMAIL_PROVIDER: "outbox", NODE_ENV: "production" }).delivery, "unavailable");
  let transportOptions: Record<string, unknown> | undefined;
  let sent: unknown;
  const smtp = createEmailSetup({ EMAIL_PROVIDER: "nodemailer", SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "mailer", SMTP_PASS: "super-secret-mail", EMAIL_FROM: "ClipForge <mailer@example.com>" }, {
    createSmtpTransport: (options) => { transportOptions = options; return { sendMail: async (message) => { sent = message; } }; },
  });
  assert.equal(smtp.delivery, "nodemailer");
  assert.equal(smtp.requireVerifiedEmail, true);
  assert.deepEqual(transportOptions?.["tls"], { minVersion: "TLSv1.2" });
  assert.equal(transportOptions?.["requireTLS"], true);
  await smtp.sender.send({ to: "ann@example.com", subject: "Confirm", text: "hidden" });
  assert.equal((sent as { from?: string }).from, "ClipForge <mailer@example.com>");
});

test("SES provider selection sends only through the selected adapter and does not expose credentials", async () => {
  let url = ""; let requestInit: RequestInit | undefined;
  const ses = createEmailSetup({ EMAIL_PROVIDER: "ses", AWS_REGION: "ap-south-1", AWS_ACCESS_KEY_ID: "synthetic-access", AWS_SECRET_ACCESS_KEY: "synthetic-secret", EMAIL_FROM: "ClipForge <mail@example.com>" }, {
    fetch: async (input, init) => { url = String(input); requestInit = init; return new Response(null, { status: 200 }); },
    now: () => new Date("2026-11-13T00:00:00Z"),
  });
  assert.equal(ses.delivery, "ses");
  assert.equal(ses.requireVerifiedEmail, true);
  await ses.sender.send({ to: "ann@example.com", subject: "Verify", text: "synthetic message" });
  assert.equal(url, "https://email.ap-south-1.amazonaws.com/v2/email/outbound-emails");
  assert.equal((requestInit?.headers as Record<string, string>)["authorization"]?.includes("synthetic-secret"), false);
});

test("missing SES or SMTP fields produce a fixed configuration error without revealing values", async () => {
  const ses = createEmailSetup({ EMAIL_PROVIDER: "ses", AWS_REGION: "ap-south-1", AWS_ACCESS_KEY_ID: "present" });
  assert.equal(ses.delivery, "unavailable");
  assert.equal(ses.configurationError, "ses_credentials_missing");
  const smtp = createEmailSetup({ EMAIL_PROVIDER: "nodemailer", SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "present", SMTP_PASS: "present" });
  assert.equal(smtp.delivery, "unavailable");
  assert.equal(smtp.configurationError, "smtp_configuration_invalid");
  assert.equal(smtp.sender instanceof Object, true);
});

test("provider delivery failures return a fixed error with no SMTP or SES response details", async () => {
  const smtp = createEmailSetup({ EMAIL_PROVIDER: "nodemailer", SMTP_HOST: "smtp.private.example", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "private-user", SMTP_PASS: "private-password", EMAIL_FROM: "from@example.com" }, {
    createSmtpTransport: () => ({ sendMail: async () => { throw new Error("private SMTP response and password"); } }),
  });
  await assert.rejects(() => smtp.sender.send({ to: "to@example.com", subject: "x", text: "y" }), (error: unknown) => error instanceof AppError && error.code === "email_delivery_failed" && !error.message.includes("private SMTP"));
  const ses = createEmailSetup({ EMAIL_PROVIDER: "ses", AWS_REGION: "ap-south-1", AWS_ACCESS_KEY_ID: "private-key", AWS_SECRET_ACCESS_KEY: "private-secret", EMAIL_FROM: "from@example.com" }, {
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

test("verification and password reset survive a new database connection", { skip: hasDatabase ? false : "DATABASE_URL is not set for this process" }, async () => {
  const email = `phase4-${randomUUID()}@clipforge.test`;
  const outbox = new MemoryEmailOutbox();
  const clock = { now: new Date("2026-11-06T12:00:00Z") };
  const open = async () => {
    const db = await createPrismaClient(databaseUrlAtStart as string);
    return { db, auth: service(new PrismaAuthRepository(db), outbox, { now: () => clock.now }) };
  };
  const first = await open();
  const closer = first.db as PrismaClientLike & { $disconnect(): Promise<void>; user: { delete(args: { where: { email: string } }): Promise<unknown> } };
  try {
    assert.deepEqual(await first.auth.register({ email, password: PASSWORD }), { ok: true });
    const verification = tokenFrom(outbox.messages.at(-1)!.text);
    assert.equal(outbox.messages.at(-1)!.text.includes(verification), true);
    await closer.$disconnect();

    const second = await open();
    const secondCloser = second.db as typeof closer;
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
      await secondCloser.$disconnect();

      const third = await open();
      const thirdCloser = third.db as typeof closer;
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
        await third.db.user.deleteMany({ where: { email: { startsWith: "phase4-" } } });
        await thirdCloser.$disconnect();
      }
    } finally { await secondCloser.$disconnect().catch(() => undefined); }
  } finally { await closer.$disconnect().catch(() => undefined); }
});
