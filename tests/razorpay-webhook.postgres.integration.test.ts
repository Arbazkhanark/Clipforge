// PostgreSQL-backed Razorpay subscription webhook integration tests.
// This file never loads dotenv files and never calls Razorpay. Requests are
// synthetic, signed locally, and use test-only provider identifiers.
// A database target is accepted only with explicit test flags and the exact
// loopback target; the shared isolatedDatabaseUrl guard is also required.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { handleRazorpayWebhook } from "../src/server/billing/razorpay-webhook-handler.ts";
import { createPrismaClient } from "../src/server/prisma/create-client.ts";
import type { PrismaClientLike } from "../src/server/prisma/prisma-client-like.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import { isolatedDatabaseUrl } from "./helpers/isolated-database.ts";

const TEST_DATABASE_HOST = "127.0.0.1";
const TEST_DATABASE_PORT = "54836";
const TEST_DATABASE_NAME = "clipforge_local_test";
const TEST_DATABASE_ROLE = "clipforge_test_admin";
const TEST_POSTGRES_VERSION = /^PostgreSQL 15\.8\b/;
const WEBHOOK_SECRET = "synthetic-postgres-webhook-test-secret";
const FIXED_NOW = new Date("2026-11-23T12:00:00.000Z");
const CURRENT_PERIOD_END = 4_102_444_800; // 2100-01-01 UTC
const EXPECTED_MIGRATIONS = [
  "20261106135723_init",
  "20261106162016_integrity_constraints",
  "20261106163300_google_identity",
  "20261106174500_instagram_account_details",
  "20261107040000_render_queue_and_local_outbox",
  "20261107050000_durable_publishing_attempts",
  "20261107060000_cycle_item_render_output_selection",
  "20261107070000_instagram_oauth_state",
  "20261107080000_recurring_razorpay_subscription_intents",
  "20261107090000_manual_payment_access",
  "20261107091000_recurring_auto_renew_consent",
  "20261107092000_subscription_continuation",
  "20261107100000_promotions_and_discounted_manual_payments",
  "20261109120000_durable_media_import_jobs",
  "20261111100000_production_migration_audit_corrections",
  "20261113133000_admin_registration",
  "20261113170000_collection_caption_cover_settings",
  "20261114100000_cycle_video_ordering_modes",
  "20261115120000_media_verification_jobs",
  "20261121120000_complimentary_access_hold",
  "20261121120000_edited_media_replacements",
  "20261122120000_admin_user_suspension",
] as const;

type TestClient = PrismaClientLike & { $disconnect(): Promise<void> };
type Fixture = {
  prefix: string;
  userId: string;
  subscriptionRowId: string;
  intentId: string;
  providerSubscriptionId: string;
  eventIds: Set<string>;
  paymentIds: Set<string>;
  ownedUser: boolean;
  ownedIntent: boolean;
  ownedSubscription: boolean;
  repoFor: (client: TestClient) => PrismaRepository;
};

function failClosed(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function resolveDatabaseUrl(): string | undefined {
  const database = process.env["DATABASE_URL"];
  const direct = process.env["DIRECT_URL"];
  if (!database && !direct) return undefined;

  failClosed(Boolean(database) && Boolean(direct), "Both database URLs are required for Razorpay PostgreSQL integration tests.");
  failClosed(database === direct, "Database URLs must match exactly for Razorpay PostgreSQL integration tests.");
  failClosed(process.env["NODE_ENV"] === "test", "NODE_ENV=test is required for Razorpay PostgreSQL integration tests.");
  failClosed(process.env["CLIPFORGE_DEPLOYMENT_ENV"] === "test", "CLIPFORGE_DEPLOYMENT_ENV=test is required for Razorpay PostgreSQL integration tests.");
  failClosed(process.env["CLIPFORGE_TEST_DATABASE_PORT"] === TEST_DATABASE_PORT, "The dedicated test database port must be explicitly configured.");

  let parsed: URL;
  try {
    parsed = new URL(database!);
  } catch {
    throw new Error("DATABASE_URL is not a valid isolated PostgreSQL test target.");
  }
  const schemas = parsed.searchParams.getAll("schema");
  failClosed(
    parsed.protocol === "postgresql:" && parsed.hostname === TEST_DATABASE_HOST &&
      parsed.port === TEST_DATABASE_PORT && parsed.pathname === `/${TEST_DATABASE_NAME}` &&
      parsed.hash === "" && [...parsed.searchParams.keys()].every((key) => key === "schema") &&
      (schemas.length === 0 || (schemas.length === 1 && schemas[0] === "public")),
    "Database URLs must target only 127.0.0.1:54836/clipforge_local_test.",
  );

  // Reuse the shared guard as an independent second check. Neither URL is ever
  // included in an assertion message or diagnostic.
  const guarded = isolatedDatabaseUrl();
  failClosed(guarded === database, "Database URLs failed the shared isolated-database guard.");
  return database;
}

const databaseUrl = resolveDatabaseUrl();
const skipReason = "Database URLs are not configured for the explicitly isolated local PostgreSQL test.";
const runId = randomUUID().replaceAll("-", "").slice(0, 20);

function fixtureIds(): Fixture {
  const prefix = `rzwh${runId}${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  return {
    prefix,
    userId: `${prefix}user`,
    subscriptionRowId: `${prefix}subrow`,
    intentId: `${prefix}intent`,
    providerSubscriptionId: `sub_${prefix}`,
    eventIds: new Set(),
    paymentIds: new Set(),
    ownedUser: false,
    ownedIntent: false,
    ownedSubscription: false,
    repoFor: (client) => new PrismaRepository(client, () => FIXED_NOW),
  };
}

async function assertLocalDatabaseAndMigrations(db: TestClient): Promise<void> {
  const identity = await db.$queryRaw`SELECT current_database() AS "databaseName",
    inet_server_addr()::text AS "serverAddress", current_setting('port') AS "serverPort",
    current_user AS "currentRole", version() AS "serverVersion"` as Array<Record<string, unknown>>;
  assert.equal(identity.length, 1, "database identity query must return one row");
  assert.equal(identity[0]?.["databaseName"], TEST_DATABASE_NAME, "unexpected PostgreSQL database");
  assert.ok([TEST_DATABASE_HOST, `${TEST_DATABASE_HOST}/32`].includes(String(identity[0]?.["serverAddress"])), "unexpected PostgreSQL loopback address");
  assert.equal(String(identity[0]?.["serverPort"]), TEST_DATABASE_PORT, "unexpected PostgreSQL port");
  assert.equal(identity[0]?.["currentRole"], TEST_DATABASE_ROLE, "unexpected PostgreSQL role");
  assert.match(String(identity[0]?.["serverVersion"]), TEST_POSTGRES_VERSION, "expected isolated PostgreSQL 15.8");

  const migrations = await db.$queryRaw`SELECT "migration_name" AS "migrationName",
    "finished_at" AS "finishedAt", "rolled_back_at" AS "rolledBackAt"
    FROM public."_prisma_migrations" ORDER BY "migration_name"` as Array<Record<string, unknown>>;
  assert.deepEqual(migrations.map((row) => row["migrationName"]), [...EXPECTED_MIGRATIONS], "expected exactly the known migration set");
  assert.ok(migrations.every((row) => row["finishedAt"] instanceof Date && row["rolledBackAt"] === null), "all expected migrations must be successfully applied");
}

function signedWebhook(event: string, eventId: string, fixture: Fixture, options: { createdAt?: number; paymentId?: string } = {}): Request {
  const createdAt = options.createdAt ?? Math.floor(FIXED_NOW.getTime() / 1000);
  const paymentId = options.paymentId ?? `pay_${eventId}`;
  const payload: Record<string, unknown> = {
    subscription: { entity: { id: fixture.providerSubscriptionId, current_end: CURRENT_PERIOD_END } },
  };
  if (event === "subscription.charged") {
    payload["payment"] = { entity: {
      id: paymentId,
      subscription_id: fixture.providerSubscriptionId,
      amount: 199900,
      currency: "INR",
      status: "captured",
    } };
  }
  const body = JSON.stringify({ event, created_at: createdAt, payload });
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  return new Request("http://clipforge.test/api/payments/razorpay/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": signature,
      "x-razorpay-event-id": eventId,
    },
    body,
  });
}

async function deliver(client: TestClient, fixture: Fixture, event: string, eventId: string, options: { createdAt?: number; paymentId?: string } = {}): Promise<{ status: number; outcome?: string }> {
  const paymentId = options.paymentId ?? `pay_${eventId}`;
  const response = await handleRazorpayWebhook(signedWebhook(event, eventId, fixture, options), {
    repo: fixture.repoFor(client),
    webhookSecret: WEBHOOK_SECRET,
    now: () => FIXED_NOW,
  });
  const body = await response.json() as { outcome?: string };
  // A repository outcome other than `duplicate` confirms this execution
  // committed the event row. Track cleanup ownership only after that success
  // is returned; planned or ambiguous IDs are never treated as owned.
  if (body.outcome === "applied" || body.outcome === "ignored" || body.outcome === "stale") {
    fixture.eventIds.add(eventId);
    if (event === "subscription.charged" && body.outcome === "applied") fixture.paymentIds.add(paymentId);
  }
  return { status: response.status, ...(body.outcome ? { outcome: body.outcome } : {}) };
}

async function seedFixture(db: TestClient, fixture: Fixture): Promise<void> {
  await db.user.create({ data: {
    id: fixture.userId,
    email: `${fixture.userId}@clipforge.invalid`,
    role: "user",
  } });
  fixture.ownedUser = true;
  await db.razorpaySubscriptionIntent.create({ data: {
    id: fixture.intentId,
    userId: fixture.userId,
    idempotencyKey: `${fixture.prefix}:checkout`,
    providerSubscriptionId: fixture.providerSubscriptionId,
    checkoutUrl: null,
    providerPlanId: "plan_synthetic_creator_monthly",
    planId: "creator",
    interval: "monthly",
    amountPaise: 199900,
    currency: "INR",
    status: "created",
    errorCategory: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  } });
  fixture.ownedIntent = true;
  await db.subscription.create({ data: {
    id: fixture.subscriptionRowId,
    userId: fixture.userId,
    planId: "creator",
    interval: "monthly",
    status: "created",
    razorpaySubscriptionId: fixture.providerSubscriptionId,
    lastEventAt: 0n,
    trialEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  } });
  fixture.ownedSubscription = true;
}

async function cleanupFixture(db: TestClient, fixture: Fixture): Promise<void> {
  if (fixture.paymentIds.size > 0) await db.paymentRecord.deleteMany({ where: { userId: fixture.userId, providerPaymentId: { in: [...fixture.paymentIds] } } });
  if (fixture.eventIds.size > 0) await db.webhookEvent.deleteMany({ where: { providerEventId: { in: [...fixture.eventIds] } } });
  if (fixture.ownedSubscription) await db.subscription.deleteMany({ where: { id: fixture.subscriptionRowId, userId: fixture.userId } });
  if (fixture.ownedIntent) await db.razorpaySubscriptionIntent.deleteMany({ where: { id: fixture.intentId, userId: fixture.userId } });
  if (fixture.ownedUser) await db.user.deleteMany({ where: { id: fixture.userId } });
}

async function withFixture(clientCount: 1 | 2, run: (clients: TestClient[], fixture: Fixture) => Promise<void>): Promise<void> {
  assert.ok(databaseUrl, skipReason);
  const clients: TestClient[] = [];
  let fixture: Fixture | undefined;
  try {
    for (let index = 0; index < clientCount; index += 1) {
      clients.push(await createPrismaClient(databaseUrl) as TestClient);
    }
    // Identity and read-only migration checks complete on every connection before
    // any fixture row can be written.
    for (const client of clients) await assertLocalDatabaseAndMigrations(client);
    fixture = fixtureIds();
    await seedFixture(clients[0]!, fixture);
    await run(clients, fixture);
  } finally {
    try {
      if (fixture && clients[0]) await cleanupFixture(clients[0], fixture);
    } finally {
      const closed = await Promise.allSettled(clients.map((client) => client.$disconnect()));
      const closeError = closed.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (closeError) throw closeError.reason;
    }
  }
}

test("PostgreSQL webhook: duplicate delivery persists one event, payment, and effective entitlement", { skip: databaseUrl ? false : skipReason }, async () => {
  await withFixture(1, async (clients, fixture) => {
    const client = clients[0];
    assert.ok(client);
    const activation = await deliver(client, fixture, "subscription.activated", `${fixture.prefix}_activate`, { createdAt: 1_800_000_000 });
    assert.deepEqual(activation, { status: 200, outcome: "applied" });
    const first = await deliver(client, fixture, "subscription.charged", `${fixture.prefix}_charge`, { createdAt: 1_800_000_100 });
    const replay = await deliver(client, fixture, "subscription.charged", `${fixture.prefix}_charge`, { createdAt: 1_800_000_100 });
    assert.deepEqual(first, { status: 200, outcome: "applied" });
    assert.deepEqual(replay, { status: 200, outcome: "duplicate" });
    assert.equal(await client.webhookEvent.count({ where: { providerEventId: { in: [...fixture.eventIds] } } }), 2);
    assert.equal(await client.paymentRecord.count({ where: { providerPaymentId: { in: [...fixture.paymentIds] } } }), 1);
    assert.equal((await client.subscription.findUnique({ where: { id: fixture.subscriptionRowId } }))?.["status"], "active");
    assert.equal((await client.razorpaySubscriptionIntent.findUnique({ where: { id: fixture.intentId } }))?.["status"], "active");
    assert.equal(await fixture.repoFor(client).getPlanIdForUser(fixture.userId, FIXED_NOW), "creator");
  });
});

test("PostgreSQL webhook: independent clients concurrently deliver one event with one effective result", { skip: databaseUrl ? false : skipReason }, async () => {
  await withFixture(2, async (clients, fixture) => {
    const [firstClient, secondClient] = clients;
    assert.ok(firstClient && secondClient);
    const activation = await deliver(firstClient, fixture, "subscription.activated", `${fixture.prefix}_activate`, { createdAt: 1_800_000_000 });
    assert.equal(activation.outcome, "applied");

    let ready = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const simultaneousDelivery = (client: TestClient) => (async () => {
      ready += 1;
      if (ready === 2) release();
      await gate;
      return deliver(client, fixture, "subscription.charged", `${fixture.prefix}_race`, { createdAt: 1_800_000_100 });
    })();
    const outcomes = await Promise.all([simultaneousDelivery(firstClient), simultaneousDelivery(secondClient)]);
    assert.deepEqual(outcomes.map((result) => result.status), [200, 200]);
    assert.equal(outcomes.filter((result) => result.outcome === "applied").length, 1);
    assert.equal(outcomes.filter((result) => result.outcome === "duplicate").length, 1);
    assert.equal(await firstClient.webhookEvent.count({ where: { providerEventId: `${fixture.prefix}_race` } }), 1);
    assert.equal(await firstClient.paymentRecord.count({ where: { providerPaymentId: `pay_${fixture.prefix}_race` } }), 1);
    assert.equal((await firstClient.subscription.findUnique({ where: { id: fixture.subscriptionRowId } }))?.["status"], "active");
    assert.equal(await fixture.repoFor(firstClient).getPlanIdForUser(fixture.userId, FIXED_NOW), "creator");
  });
});

function repositoryFailingAtPaymentCreate(client: TestClient): PrismaClientLike {
  const wrapTransactionClient = (tx: PrismaClientLike): PrismaClientLike => new Proxy(tx as object, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "paymentRecord" && typeof value === "object" && value !== null) {
        return new Proxy(value, {
          get(delegate, method) {
            const operation = Reflect.get(delegate, method, delegate) as unknown;
            if (method === "create") return async () => {
              throw new Error("synthetic payment-record write failure");
            };
            return typeof operation === "function" ? operation.bind(delegate) : operation;
          },
        });
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClientLike;

  return new Proxy(client as object, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "$transaction" && typeof value === "function") {
        return (work: (tx: PrismaClientLike) => Promise<unknown>) => value.call(target, (tx: PrismaClientLike) => work(wrapTransactionClient(tx)));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClientLike;
}

test("PostgreSQL webhook: failed payment write rolls back prior event and subscription writes, then retry succeeds", { skip: databaseUrl ? false : skipReason }, async () => {
  await withFixture(1, async (clients, fixture) => {
    const client = clients[0];
    assert.ok(client);
    const activation = await deliver(client, fixture, "subscription.activated", `${fixture.prefix}_activate`, { createdAt: 1_800_000_000 });
    assert.equal(activation.outcome, "applied");
    const failedEventId = `${fixture.prefix}_rollback`;
    const failedPaymentId = `pay_${failedEventId}`;
    const wrapped = repositoryFailingAtPaymentCreate(client);
    const failed = await handleRazorpayWebhook(signedWebhook("subscription.charged", failedEventId, fixture, { createdAt: 1_800_000_100, paymentId: failedPaymentId }), {
      repo: new PrismaRepository(wrapped, () => FIXED_NOW),
      webhookSecret: WEBHOOK_SECRET,
      now: () => FIXED_NOW,
    });
    assert.equal(failed.status, 503, "injected transaction failure must not be acknowledged");
    assert.equal(await client.webhookEvent.count({ where: { providerEventId: failedEventId } }), 0, "the earlier WebhookEvent insert must roll back");
    assert.equal(await client.paymentRecord.count({ where: { providerPaymentId: failedPaymentId } }), 0);
    assert.equal((await client.subscription.findUnique({ where: { id: fixture.subscriptionRowId } }))?.["status"], "authenticated", "the earlier subscription update must roll back");
    assert.equal((await client.razorpaySubscriptionIntent.findUnique({ where: { id: fixture.intentId } }))?.["status"], "created", "intent state must roll back with the event");

    const retried = await deliver(client, fixture, "subscription.charged", failedEventId, { createdAt: 1_800_000_100, paymentId: failedPaymentId });
    assert.deepEqual(retried, { status: 200, outcome: "applied" });
    assert.equal(await client.webhookEvent.count({ where: { providerEventId: failedEventId } }), 1);
    assert.equal(await client.paymentRecord.count({ where: { providerPaymentId: failedPaymentId } }), 1);
    assert.equal((await client.subscription.findUnique({ where: { id: fixture.subscriptionRowId } }))?.["status"], "active");
    assert.equal((await client.razorpaySubscriptionIntent.findUnique({ where: { id: fixture.intentId } }))?.["status"], "active");
    assert.equal(await fixture.repoFor(client).getPlanIdForUser(fixture.userId, FIXED_NOW), "creator");
  });
});

test("PostgreSQL webhook: stale out-of-order event is recorded as ignored without entitlement regression", { skip: databaseUrl ? false : skipReason }, async () => {
  await withFixture(1, async (clients, fixture) => {
    const client = clients[0];
    assert.ok(client);
    const activation = await deliver(client, fixture, "subscription.activated", `${fixture.prefix}_activate`, { createdAt: 1_800_000_000 });
    const charge = await deliver(client, fixture, "subscription.charged", `${fixture.prefix}_charge`, { createdAt: 1_800_000_200 });
    const stale = await deliver(client, fixture, "subscription.halted", `${fixture.prefix}_stale`, { createdAt: 1_800_000_100 });
    assert.equal(activation.outcome, "applied");
    assert.equal(charge.outcome, "applied");
    assert.deepEqual(stale, { status: 200, outcome: "stale" });
    assert.equal((await client.webhookEvent.findUnique({ where: { providerEventId: `${fixture.prefix}_stale` } }))?.["status"], "ignored");
    assert.equal((await client.subscription.findUnique({ where: { id: fixture.subscriptionRowId } }))?.["status"], "active");
    assert.equal(await fixture.repoFor(client).getPlanIdForUser(fixture.userId, FIXED_NOW), "creator");
  });
});
