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
    if (compound[key] && isPlainObject(condition)) { if (!compound[key]!.every((f) => same(row[f], (condition as Row)[f]))) return false; continue; }
    const value = row[key];
    if (isPlainObject(condition)) {
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
class FakeDelegate implements ModelDelegate {
  rows: Row[] = []; private uniques: string[][]; private compound: Record<string, string[]>;
  constructor(uniques: string[][], compound: Record<string, string[]> = {}) { this.uniques = [["id"], ...uniques]; this.compound = compound; }

  private withDefaults(data: Row): Row { return { ...(data["id"] === undefined ? { id: `fake${++autoId}` } : {}), ...(data["createdAt"] === undefined ? { createdAt: new Date() } : {}), ...structuredClone(data) }; }
  private find(where: Where | undefined): Row[] { return this.rows.filter((r) => matches(r, where, this.compound)); }
  private sort(rows: Row[], orderBy: unknown): Row[] {
    const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Record<string, "asc" | "desc">[];
    return [...rows].sort((a, b) => { for (const k of keys) { const [f, dir] = Object.entries(k)[0] as [string, "asc" | "desc"]; const x = comparable(a[f]), y = comparable(b[f]); if (x < y) return dir === "asc" ? -1 : 1; if (x > y) return dir === "asc" ? 1 : -1; } return 0; });
  }
  async findUnique(args: { where: Where }): Promise<Row | null> { await tick(); const r = this.find(args.where)[0]; return r ? structuredClone(r) : null; }
  async findFirst(args: { where?: Where; orderBy?: unknown }): Promise<Row | null> { await tick(); const r = this.sort(this.find(args.where), args.orderBy)[0]; return r ? structuredClone(r) : null; }
  async findMany(args: { where?: Where; orderBy?: unknown; skip?: number; take?: number } = {}): Promise<Row[]> {
    await tick(); const sorted = this.sort(this.find(args.where), args.orderBy); const start = args.skip ?? 0;
    return sorted.slice(start, args.take === undefined ? undefined : start + args.take).map((r) => structuredClone(r));
  }
  async count(args: { where?: Where } = {}): Promise<number> { await tick(); return this.find(args.where).length; }
  private insert(data: Row): Row {
    const row = this.withDefaults(data);
    for (const fields of this.uniques) {
      if (fields.some((f) => row[f] == null)) continue;
      if (this.rows.some((existing) => fields.every((f) => same(existing[f], row[f])))) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    }
    this.rows.push(row); return row;
  }
  async create(args: { data: Row }): Promise<Row> { await tick(); return structuredClone(this.insert(args.data)); }
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
    for (const row of targets) for (const [k, v] of Object.entries(args.data)) if (v !== undefined) row[k] = structuredClone(v);
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
  mediaAsset = new FakeDelegate([["storageKey"]]); mediaDerivative = new FakeDelegate([["storageKey"], ["mediaAssetId", "ownerId", "kind", "settingsHash"]]); videoCollection = new FakeDelegate([]); collectionItem = new FakeDelegate([["collectionId", "mediaAssetId"]]);
  collectionPermission = new FakeDelegate([["collectionId", "granteeId"]], { collectionId_granteeId: ["collectionId", "granteeId"] });
  publishingCycle = new FakeDelegate([]); cycleItem = new FakeDelegate([]); captionRevision = new FakeDelegate([]); auditLog = new FakeDelegate([]); editingTemplate = new FakeDelegate([]);
  socialAccount = new FakeDelegate([]); subscription = new FakeDelegate([["userId"]]); usageRecord = new FakeDelegate([["idempotencyKey"]]);
  private chain: Promise<unknown> = Promise.resolve();
  /** Transactions run one after another, which is what a row lock gives us in PostgreSQL. (Rollback is NOT simulated.) */
  $transaction<T>(work: (tx: PrismaClientLike) => Promise<T>): Promise<T> {
    const run = this.chain.then(() => work(this));
    this.chain = run.catch(() => undefined);
    return run;
  }
  async $queryRaw(): Promise<unknown> { return []; }
}
