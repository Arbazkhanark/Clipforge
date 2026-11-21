// A FAKE of the Prisma Client slice in src/server/prisma/prisma-client-like.ts.
// It follows Prisma's DOCUMENTED behaviour (updateMany -> { count }, unique violation -> error code P2002, aggregate sums,
// where operators in/not/gt/gte/lt/lte, orderBy/skip/take, $transaction) - but it is NOT Prisma and NOT PostgreSQL.
// Passing tests against it proves our repository LOGIC, not that real Prisma behaves identically.
import type { ModelDelegate, PrismaClientLike, Row, Where } from "../../src/server/prisma/prisma-client-like.ts";

const tick = (): Promise<void> => Promise.resolve();
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !(v instanceof Date) && !Array.isArray(v);
const comparable = (v: unknown): number | string | bigint => (v instanceof Date ? v.getTime() : (v as number | string | bigint));
const same = (a: unknown, b: unknown): boolean => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : (a ?? null) === (b ?? null));

function matches(row: Row, where: Where | undefined, compound: Record<string, string[]>): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR" && Array.isArray(condition)) { if (!condition.some((part) => matches(row, part as Where, compound))) return false; continue; }
    if (key === "AND" && Array.isArray(condition)) { if (!condition.every((part) => matches(row, part as Where, compound))) return false; continue; }
    if (compound[key] && isPlainObject(condition)) { if (!compound[key]!.every((f) => same(row[f], (condition as Row)[f]))) return false; continue; }
    const value = row[key];
    if (isPlainObject(condition)) {
      if (key === "metadata" && Array.isArray((condition as Row)["path"]) && "equals" in condition) {
        const path = (condition as Row)["path"] as string[];
        let selected: unknown = value;
        for (const part of path) selected = isPlainObject(selected) ? selected[part] : undefined;
        if (!same(selected, (condition as Row)["equals"])) return false;
        continue;
      }
      for (const [op, operand] of Object.entries(condition)) {
        if (op === "mode") continue;
        if (op === "in") { if (!(operand as unknown[]).some((o) => same(value, o))) return false; }
        else if (op === "not") { if (same(value, operand)) return false; }
        else if (op === "equals") { if (!same(value, operand)) return false; }
        else if (value == null) return false;
        else if (op === "gt") { if (!(comparable(value) > comparable(operand))) return false; }
        else if (op === "gte") { if (!(comparable(value) >= comparable(operand))) return false; }
        else if (op === "lt") { if (!(comparable(value) < comparable(operand))) return false; }
        else if (op === "lte") { if (!(comparable(value) <= comparable(operand))) return false; }
        else if (op === "contains") {
          const haystack = String(value ?? "");
          const needle = String(operand);
          const insensitive = (condition as Row)["mode"] === "insensitive";
          if (!(insensitive ? haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase()) : haystack.includes(needle))) return false;
        }
        else throw new Error(`fake prisma: unsupported operator ${op}`);
      }
    } else if (!same(value, condition)) return false;
  }
  return true;
}

let autoId = 0;
let autoPromotionSequence = 0n;
class FakeDelegate implements ModelDelegate {
  rows: Row[] = []; private uniques: string[][]; private compound: Record<string, string[]>;
  beforeCreate: ((data: Row) => void) | null = null;
  constructor(uniques: string[][], compound: Record<string, string[]> = {}) { this.uniques = [["id"], ...uniques]; this.compound = compound; }

  private withDefaults(data: Row): Row { return { ...(data["id"] === undefined ? { id: `fake${++autoId}` } : {}), ...(data["createdAt"] === undefined ? { createdAt: new Date() } : {}), ...(data["queueSequence"] === undefined && "durationDays" in data && "promotionId" in data ? { queueSequence: ++autoPromotionSequence } : {}), ...structuredClone(data) }; }
  private find(where: Where | undefined): Row[] { return this.rows.filter((r) => matches(r, where, this.compound)); }
  private sort(rows: Row[], orderBy: unknown): Row[] {
    const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Record<string, "asc" | "desc">[];
    return [...rows].sort((a, b) => { for (const k of keys) { const [f, dir] = Object.entries(k)[0] as [string, "asc" | "desc"]; const x = comparable(a[f]), y = comparable(b[f]); if (x < y) return dir === "asc" ? -1 : 1; if (x > y) return dir === "asc" ? 1 : -1; } return 0; });
  }
  private project(row: Row, select?: Record<string, boolean>): Row { if (!select) return structuredClone(row); const projected: Row = {}; for (const [key, enabled] of Object.entries(select)) if (enabled) projected[key] = structuredClone(row[key]); return projected; }
  async findUnique(args: { where: Where; select?: Record<string, boolean> }): Promise<Row | null> { await tick(); const r = this.find(args.where)[0]; return r ? this.project(r, args.select) : null; }
  async findFirst(args: { where?: Where; select?: Record<string, boolean>; orderBy?: unknown }): Promise<Row | null> { await tick(); const r = this.sort(this.find(args.where), args.orderBy)[0]; return r ? this.project(r, args.select) : null; }
  async findMany(args: { where?: Where; select?: Record<string, boolean>; orderBy?: unknown; skip?: number; take?: number } = {}): Promise<Row[]> {
    await tick(); const sorted = this.sort(this.find(args.where), args.orderBy); const start = args.skip ?? 0;
    return sorted.slice(start, args.take === undefined ? undefined : start + args.take).map((r) => this.project(r, args.select));
  }
  async count(args: { where?: Where } = {}): Promise<number> { await tick(); return this.find(args.where).length; }
  async groupBy(args: { by: string[]; where?: Where; _count: { _all: true } }): Promise<Row[]> {
    await tick();
    const groups = new Map<string, { keys: Row; count: number }>();
    for (const row of this.find(args.where)) {
      const keys: Row = {}; for (const key of args.by) keys[key] = row[key];
      const signature = JSON.stringify(keys);
      const existing = groups.get(signature);
      if (existing) existing.count += 1; else groups.set(signature, { keys, count: 1 });
    }
    return [...groups.values()].map((group) => ({ ...structuredClone(group.keys), _count: { _all: group.count } }));
  }
  private insert(data: Row): Row {
    const row = this.withDefaults(data);
    for (const fields of this.uniques) {
      if (fields.some((f) => row[f] == null)) continue;
      if (this.rows.some((existing) => fields.every((f) => same(existing[f], row[f])))) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    }
    this.rows.push(row); return row;
  }
  async create(args: { data: Row }): Promise<Row> { await tick(); this.beforeCreate?.(args.data); return structuredClone(this.insert(args.data)); }
  async createMany(args: { data: Row[] }): Promise<{ count: number }> { await tick(); for (const d of args.data) this.insert(d); return { count: args.data.length }; }
  async update(args: { where: Where; data: Row }): Promise<Row> {
    await tick(); const row = this.find(args.where)[0];
    if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
    for (const [k, v] of Object.entries(args.data)) if (v !== undefined) row[k] = structuredClone(v);
    return structuredClone(row);
  }
  async updateMany(args: { where?: Where; data: Row }): Promise<{ count: number }> {
    await tick(); // no await between matching and writing: atomic, like one SQL UPDATE
    const targets = this.find(args.where);
    for (const row of targets) for (const [k, v] of Object.entries(args.data)) if (v !== undefined) {
      if (isPlainObject(v) && typeof v["increment"] === "number") row[k] = Number(row[k] ?? 0) + v["increment"];
      else row[k] = structuredClone(v);
    }
    return { count: targets.length };
  }
  async upsert(args: { where: Where; create: Row; update: Row }): Promise<Row> {
    await tick(); const existing = this.find(args.where)[0];
    if (existing) { for (const [k, v] of Object.entries(args.update)) if (v !== undefined) existing[k] = structuredClone(v); return structuredClone(existing); }
    return structuredClone(this.insert(args.create));
  }
  async deleteMany(args: { where?: Where } = {}): Promise<{ count: number }> {
    await tick();
    const targets = new Set(this.find(args.where));
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !targets.has(row));
    return { count: before - this.rows.length };
  }
  async aggregate(args: { where?: Where; _sum: Record<string, true> }): Promise<{ _sum: Record<string, bigint | number | null> }> {
    await tick(); const rows = this.find(args.where); const out: Record<string, bigint | number | null> = {};
    for (const field of Object.keys(args._sum)) {
      const values = rows.map((r) => r[field]).filter((v) => v != null) as (bigint | number)[];
      out[field] = values.length === 0 ? null : values.some((v) => typeof v === "bigint") ? values.reduce<bigint>((a, v) => a + BigInt(v), 0n) : values.reduce<number>((a, v) => a + (v as number), 0);
    }
    return { _sum: out };
  }
}

export class FakePrismaClient implements PrismaClientLike {
  user = new FakeDelegate([["email"]]); session = new FakeDelegate([["tokenHash"]]); authToken = new FakeDelegate([["tokenHash"]]); googleIdentity = new FakeDelegate([["userId"], ["googleSub"]]);
  userSuspension = new FakeDelegate([["userId"]]);
  mediaAsset = new FakeDelegate([["storageKey"]]); mediaDerivative = new FakeDelegate([["storageKey"], ["mediaAssetId", "ownerId", "kind", "settingsHash"], ["id", "ownerId", "mediaAssetId"]]); mediaImportJob = new FakeDelegate([["idempotencyKey"], ["resultMediaAssetId"]]); editedMediaReplacement = new FakeDelegate([["idempotencyKey"], ["plannedReplacementMediaAssetId"], ["replacementMediaAssetId"], ["ownerId", "sourceMediaAssetId", "sourceDerivativeId"]]); videoCollection = new FakeDelegate([]); collectionItem = new FakeDelegate([["collectionId", "mediaAssetId"]], { collectionId_mediaAssetId: ["collectionId", "mediaAssetId"] });
  collectionPermission = new FakeDelegate([["collectionId", "granteeId"]], { collectionId_granteeId: ["collectionId", "granteeId"] }); collectionAccessRequest = new FakeDelegate([]); collectionShareLink = new FakeDelegate([["tokenHash"]]);
  publishingCycle = new FakeDelegate([]); cycleItem = new FakeDelegate([]); publishingJob = new FakeDelegate([["idempotencyKey"], ["cycleItemId", "attemptNumber"]]); processingJob = new FakeDelegate([["idempotencyKey"]]); captionRevision = new FakeDelegate([]); auditLog = new FakeDelegate([]); editingTemplate = new FakeDelegate([]);
  socialAccount = new FakeDelegate([]); subscription = new FakeDelegate([["userId"], ["razorpaySubscriptionId"]]); razorpaySubscriptionIntent = new FakeDelegate([["userId", "idempotencyKey"], ["providerSubscriptionId"], ["subscriptionId"]], { userId_idempotencyKey: ["userId", "idempotencyKey"] }); razorpaySubscriptionContinuation = new FakeDelegate([["subscriptionId", "cycleEnd"]], { subscriptionId_cycleEnd: ["subscriptionId", "cycleEnd"] }); manualPaymentIntent = new FakeDelegate([["userId", "idempotencyKey"], ["providerPaymentLinkId"]], { userId_idempotencyKey: ["userId", "idempotencyKey"] }); manualPlanAccess = new FakeDelegate([["intentId"], ["providerPaymentId"]]); webhookEvent = new FakeDelegate([["providerEventId"]]); paymentRecord = new FakeDelegate([["providerPaymentId"]]); usageRecord = new FakeDelegate([["idempotencyKey"]]);
  promotion = new FakeDelegate([["code"]]); promotionRedemption = new FakeDelegate([["userId", "idempotencyKey"]], { userId_idempotencyKey: ["userId", "idempotencyKey"] }); promotionalAccessGrant = new FakeDelegate([["queueSequence"], ["redemptionId"]]); promotionLifecycleEvent = new FakeDelegate([["eventKey"]]); complimentaryAccessGrant = new FakeDelegate([]); complimentaryAccessEvent = new FakeDelegate([["eventKey"]]);
  lockLog: string[] = [];
  afterTransactionRollback: ((error: unknown) => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** Transactions run one after another. A thrown error restores the rows from before the transaction. */
  $transaction<T>(work: (tx: PrismaClientLike) => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const snapshot = new Map<string, Row[]>();
      for (const [key, value] of Object.entries(this)) {
        if (value && typeof value === "object" && "rows" in value && Array.isArray((value as { rows: Row[] }).rows)) snapshot.set(key, structuredClone((value as { rows: Row[] }).rows));
      }
      try { return await work(this); }
      catch (error) {
        for (const [key, rows] of snapshot) (this as unknown as Record<string, { rows: Row[] }>)[key]!.rows = rows;
        this.afterTransactionRollback?.(error);
        throw error;
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> {
    if (strings.join("?").includes('INNER JOIN "Subscription"') && strings.join("?").includes("FOR UPDATE OF u")) {
      const providerId = values[0];
      const subscription = typeof providerId === "string" ? await this.subscription.findFirst({ where: { razorpaySubscriptionId: providerId }, select: { userId: true } }) : null;
      const userId = subscription?.["userId"];
      if (typeof userId === "string" && await this.user.findUnique({ where: { id: userId } })) { this.lockLog.push(`user:${userId}`); return [{ userId }]; }
      return [];
    }
    if (strings.join("?").includes('FROM "User"') && strings.join("?").includes("FOR UPDATE")) {
      const userIds = values.filter((value): value is string => typeof value === "string");
      const rows: { id: string }[] = [];
      for (const userId of [...new Set(userIds)].sort()) {
        if (await this.user.findUnique({ where: { id: userId } })) { this.lockLog.push(`user:${userId}`); rows.push({ id: userId }); }
      }
      return rows;
    }
    if (strings.join("?").includes('FROM "SocialAccount"') && strings.join("?").includes("FOR UPDATE")) {
      const accountId = values[0];
      return typeof accountId === "string" && await this.socialAccount.findUnique({ where: { id: accountId } }) ? [{ id: accountId }] : [];
    }
    if (strings.join("?").includes('FROM "PublishingCycle"') && strings.join("?").includes("FOR UPDATE")) {
      const cycleId = values[0];
      const ownerId = values[1];
      const cycle = typeof cycleId === "string" ? await this.publishingCycle.findUnique({ where: { id: cycleId } }) : null;
      if (cycle && (typeof ownerId !== "string" || cycle["ownerId"] === ownerId)) { this.lockLog.push(`cycle:${String(cycleId)}`); return [{ id: cycleId }]; }
      return [];
    }
    if (strings.join("?").includes('FROM "VideoCollection"') && strings.join("?").includes("FOR SHARE")) {
      const collectionId = values[0];
      const collection = typeof collectionId === "string" ? await this.videoCollection.findUnique({ where: { id: collectionId } }) : null;
      if (collection) { this.lockLog.push(`collection-share:${String(collectionId)}`); return [{ settingsVersion: collection["settingsVersion"] }]; }
      return [];
    }
    if (strings.join("?").includes('FROM "VideoCollection"') && strings.join("?").includes("FOR UPDATE")) {
      const collectionId = values[0];
      const ownerId = values[1];
      const collection = typeof collectionId === "string" ? await this.videoCollection.findUnique({ where: { id: collectionId } }) : null;
      if (collection && (typeof ownerId !== "string" || collection["ownerId"] === ownerId)) { this.lockLog.push(`collection:${String(collectionId)}`); return [{ id: collectionId }]; }
      return [];
    }
    if (strings.join("?").includes('FROM "MediaAsset"') && strings.join("?").includes("FOR UPDATE")) {
      const mediaId = values[0]; const ownerId = values[1];
      const media = typeof mediaId === "string" ? await this.mediaAsset.findUnique({ where: { id: mediaId } }) : null;
      if (media && (typeof ownerId !== "string" || media["ownerId"] === ownerId)) { this.lockLog.push(`media:${String(mediaId)}`); return [{ id: mediaId }]; }
      return [];
    }
    if (strings.join("?").includes('FROM "MediaImportJob"') && strings.join("?").includes("FOR UPDATE")) {
      const jobId = values[0];
      if (typeof jobId === "string" && await this.mediaImportJob.findUnique({ where: { id: jobId } })) { this.lockLog.push(`import-job:${jobId}`); return [{ id: jobId }]; }
      return [];
    }
    if (strings.join("?").includes('FROM "Promotion"') && strings.join("?").includes("FOR UPDATE")) {
      const promotionId = values[0];
      return typeof promotionId === "string" && await this.promotion.findUnique({ where: { id: promotionId } }) ? [{ id: promotionId }] : [];
    }
    if (strings.join("?").includes('FROM "Subscription"') && strings.join("?").includes("FOR UPDATE")) { this.lockLog.push(`subscription:${String(values[0])}`); return []; }
    return [];
  }
}
