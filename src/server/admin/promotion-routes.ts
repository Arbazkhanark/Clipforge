import { isPlanId, PLAN_CATALOG } from "../../lib/billing/catalog.ts";
import { normalizePromotionCode, validPromotionRecord } from "../../lib/domain/promotions.ts";
import type { PromotionRecord, PromotionType } from "../repository.ts";
import { AppError } from "../errors.ts";
import { readSmallJson } from "../billing/request-json.ts";
import { getRuntime, type Runtime } from "../runtime.ts";
import { adminApiRoute } from "./api-route.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const COUPON_FIELDS = new Set(["type", "code", "discountType", "discountValue", "eligiblePlanIds", "accessPlanId", "durationDays", "targetUserId", "startsAt", "expiresAt", "usageLimit", "reason"]);
const MAX_PROMOTION_OFFSET = 10_000;

function parseDate(value: unknown, optional: boolean): Date | null {
  if (optional && value === null) return null;
  if (typeof value !== "string" || value.length > 40) throw new AppError(400, "invalid_promotion", "Coupon dates are invalid.");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new AppError(400, "invalid_promotion", "Coupon dates must be valid ISO timestamps.");
  return date;
}

function parseCoupon(value: unknown, adminId: string, id: string, now: Date): PromotionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "invalid_promotion", "Coupon details are invalid.");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !COUPON_FIELDS.has(key))) throw new AppError(400, "invalid_promotion", "Coupon details contain unsupported fields.");
  if (body.type !== "discount_coupon" && body.type !== "free_access_coupon") throw new AppError(400, "invalid_promotion", "Coupon type is invalid.");
  const type: PromotionType = body.type;
  if (typeof body.code !== "string") throw new AppError(400, "invalid_promotion", "Coupon code is required.");
  const code = normalizePromotionCode(body.code);
  if (!/^[A-Z0-9_-]{3,64}$/.test(code)) throw new AppError(400, "invalid_promotion", "Coupon code must be 3 to 64 letters, numbers, hyphens, or underscores.");
  const startsAt = parseDate(body.startsAt, false)!;
  const expiresAt = parseDate(body.expiresAt, true);
  if (expiresAt && expiresAt <= startsAt) throw new AppError(400, "invalid_promotion", "Coupon expiry must be after its start time.");
  const targetUserId = body.targetUserId === undefined || body.targetUserId === null ? null : body.targetUserId;
  if (targetUserId !== null && (typeof targetUserId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(targetUserId))) throw new AppError(400, "invalid_promotion", "Target user is invalid.");
  const usageLimit = body.usageLimit === undefined || body.usageLimit === null ? null : body.usageLimit;
  if (usageLimit !== null && (!Number.isSafeInteger(usageLimit) || (usageLimit as number) < 1)) throw new AppError(400, "invalid_promotion", "Usage limit must be a positive whole number.");
  const reason = body.reason === undefined || body.reason === null ? null : body.reason;
  if (reason !== null && (typeof reason !== "string" || reason.length > 500)) throw new AppError(400, "invalid_promotion", "Reason must be 500 characters or fewer.");

  let discountType: PromotionRecord["discountType"] = null;
  let discountValue: number | null = null;
  let accessPlanId: PromotionRecord["accessPlanId"] = null;
  let durationDays: number | null = null;
  let eligiblePlanIds: PromotionRecord["eligiblePlanIds"] = [];
  if (type === "discount_coupon") {
    if (body.accessPlanId !== undefined || body.durationDays !== undefined) throw new AppError(400, "invalid_promotion", "Discount coupons cannot grant free access.");
    if (body.discountType !== "percentage" && body.discountType !== "fixed_amount") throw new AppError(400, "invalid_promotion", "Discount type is invalid.");
    if (!Number.isSafeInteger(body.discountValue) || (body.discountValue as number) < 1) throw new AppError(400, "invalid_promotion", "Discount value must be a positive whole number.");
    if (!Array.isArray(body.eligiblePlanIds) || body.eligiblePlanIds.length === 0 || body.eligiblePlanIds.length > 3 || body.eligiblePlanIds.some((plan) => typeof plan !== "string" || !isPlanId(plan) || plan === "free") || new Set(body.eligiblePlanIds).size !== body.eligiblePlanIds.length) {
      throw new AppError(400, "invalid_promotion", "Choose one or more eligible paid plans.");
    }
    discountType = body.discountType;
    discountValue = body.discountValue as number;
    eligiblePlanIds = body.eligiblePlanIds as PromotionRecord["eligiblePlanIds"];
    if (discountType === "percentage" && discountValue > 50) throw new AppError(400, "invalid_promotion", "Percentage discounts cannot exceed 50%.");
    if (discountType === "fixed_amount" && eligiblePlanIds.some((plan) => ["weekly", "monthly"].some((interval) => discountValue! > Math.floor(PLAN_CATALOG[plan]["pricePaise"][interval as "weekly" | "monthly"] / 2)))) {
      throw new AppError(400, "invalid_promotion", "Fixed discounts cannot exceed 50% of an eligible plan price.");
    }
  } else {
    if (body.discountType !== undefined || body.discountValue !== undefined || body.eligiblePlanIds !== undefined) throw new AppError(400, "invalid_promotion", "Free-access coupons cannot include a discount.");
    if (typeof body.accessPlanId !== "string" || !isPlanId(body.accessPlanId) || body.accessPlanId === "free" || !Number.isSafeInteger(body.durationDays) || (body.durationDays as number) < 1 || (body.durationDays as number) > 30) {
      throw new AppError(400, "invalid_promotion", "Free-access coupons require a paid tier and a duration from 1 to 30 days.");
    }
    accessPlanId = body.accessPlanId;
    durationDays = body.durationDays as number;
  }

  const record: PromotionRecord = {
    id, type, status: "draft", code, discountType, discountValue, accessPlanId, durationDays, eligiblePlanIds,
    targetUserId: targetUserId as string | null, startsAt, expiresAt, usageLimit: usageLimit as number | null,
    createdByAdminId: adminId, reason: reason as string | null, createdAt: now, updatedAt: now,
  };
  if (!validPromotionRecord(record)) throw new AppError(400, "invalid_promotion", "Coupon details are invalid.");
  return record;
}

function couponUsageDto(record: PromotionRecord, counts: { reserved: number; redeemed: number; released: number; manualReview: number }) {
  const countsTowardUsageLimit = counts.reserved + counts.redeemed + counts.manualReview;
  return { ...counts, countsTowardUsageLimit, usageLimit: record.usageLimit, remainingSlots: record.usageLimit === null ? null : Math.max(0, record.usageLimit - countsTowardUsageLimit) };
}

function couponDto(record: PromotionRecord, counts = { reserved: 0, redeemed: 0, released: 0, manualReview: 0 }) {
  return {
    id: record.id, type: record.type, status: record.status, code: record.code, discountType: record.discountType,
    // discountValue is integer paise for fixed_amount and whole percentage points for percentage.
    discountValue: record.discountValue,
    discountValueUnit: record.discountType === "fixed_amount" ? "paise" : record.discountType === "percentage" ? "percentage_points" : null,
    accessPlanId: record.accessPlanId, durationDays: record.durationDays,
    eligiblePlanIds: [...record.eligiblePlanIds], targetUserId: record.targetUserId, startsAt: record.startsAt.toISOString(),
    expiresAt: record.expiresAt?.toISOString() ?? null, usageLimit: record.usageLimit,
    createdByAdminId: record.createdByAdminId, reason: record.reason, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
    usage: couponUsageDto(record, counts),
  };
}

function parseHistoryPage(request: Request): { page: number; pageSize: number; skip: number } {
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((key) => !["page", "pageSize"].includes(key)) || [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)) throw new AppError(400, "invalid_admin_query", "Unsupported history query parameter.");
  const page = url.searchParams.has("page") ? Number(url.searchParams.get("page")) : 1;
  const pageSize = url.searchParams.has("pageSize") ? Number(url.searchParams.get("pageSize")) : 25;
  const skip = (page - 1) * pageSize;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isSafeInteger(skip) || skip > MAX_PROMOTION_OFFSET) throw new AppError(400, "invalid_admin_query", `History pagination is invalid; offset cannot exceed ${MAX_PROMOTION_OFFSET}.`);
  return { page, pageSize, skip };
}

function couponIdFromRequest(request: Request): string {
  const encodedId = new URL(request.url).pathname.split("/").filter(Boolean).at(-2) ?? "";
  let promotionId: string;
  try { promotionId = decodeURIComponent(encodedId); } catch { throw new AppError(400, "invalid_promotion_id", "Coupon identifier is invalid."); }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(promotionId)) throw new AppError(400, "invalid_promotion_id", "Coupon identifier is invalid.");
  return promotionId;
}

export function createAdminPromotionsRoute(runtime: () => Runtime = getRuntime) {
  return adminApiRoute(async (request, adminId) => {
    const current = runtime();
    if (request.method === "GET") {
      const url = new URL(request.url);
      if ([...url.searchParams.keys()].some((key) => !["page", "pageSize", "search", "type", "status"].includes(key)) || [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)) throw new AppError(400, "invalid_admin_query", "Unsupported coupon query parameter.");
      const page = url.searchParams.has("page") ? Number(url.searchParams.get("page")) : 1;
      const pageSize = url.searchParams.has("pageSize") ? Number(url.searchParams.get("pageSize")) : 25;
      const rawSearch = url.searchParams.get("search")?.trim() ?? "";
      const search = rawSearch.toLocaleUpperCase("en-US");
      const type = url.searchParams.get("type");
      const status = url.searchParams.get("status");
      if (rawSearch.length > 64 || (search !== "" && !/^[A-Z0-9_-]+$/.test(search))) throw new AppError(400, "invalid_admin_query", "Coupon code search must contain at most 64 letters, numbers, hyphens, or underscores.");
      if (type !== null && type !== "discount_coupon" && type !== "free_access_coupon") throw new AppError(400, "invalid_admin_query", "Coupon type filter is invalid.");
      if (status !== null && !["draft", "active", "paused", "expired", "revoked"].includes(status)) throw new AppError(400, "invalid_admin_query", "Coupon status filter is invalid.");
      const skip = (page - 1) * pageSize;
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isSafeInteger(skip) || skip > MAX_PROMOTION_OFFSET) {
        throw new AppError(400, "invalid_admin_query", `Coupon pagination is invalid; offset cannot exceed ${MAX_PROMOTION_OFFSET}.`);
      }
      const result = await current.repo.listPromotions({ skip, take: pageSize, ...(search ? { search } : {}), ...(type ? { type: type as "discount_coupon" | "free_access_coupon" } : {}), ...(status ? { status: status as PromotionRecord["status"] } : {}) });
      const usage = await current.repo.getPromotionUsageCounts(result.items.map((item) => item.id));
      return json({ data: result.items.map((item) => couponDto(item, usage[item.id] ?? { reserved: 0, redeemed: 0, released: 0, manualReview: 0 })), page, pageSize, total: result.total });
    }
    if (request.method === "POST") {
      const parsed = await readSmallJson(request);
      if (!parsed.ok) throw new AppError(parsed.status, parsed.error, "Coupon request could not be read.");
      const record = parseCoupon(parsed.value, adminId, current.newId(), current.now());
      if (!await current.repo.createPromotion(record)) throw new AppError(409, "coupon_conflict", "Coupon could not be created because its code or target conflicts with an existing record.");
      return json({ data: couponDto(record) }, 201);
    }
    throw new AppError(405, "method_not_allowed", "This coupon endpoint supports GET and POST only.");
  }, runtime);
}

export function createAdminPromotionDetailRoute(runtime: () => Runtime = getRuntime) {
  return adminApiRoute(async (request) => {
    if (request.method !== "GET") throw new AppError(405, "method_not_allowed", "This coupon detail endpoint is read-only.");
    const encodedId = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    let promotionId: string;
    try { promotionId = decodeURIComponent(encodedId); } catch { throw new AppError(400, "invalid_promotion_id", "Coupon identifier is invalid."); }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(promotionId)) throw new AppError(400, "invalid_promotion_id", "Coupon identifier is invalid.");
    const promotion = await runtime().repo.getPromotion(promotionId);
    if (!promotion) throw new AppError(404, "not_found", "Coupon was not found.");
    if (promotion.type !== "discount_coupon" && promotion.type !== "free_access_coupon") throw new AppError(404, "not_found", "Coupon was not found.");
    const usage = await runtime().repo.getPromotionUsageCounts([promotion.id]);
    const response = json({ data: couponDto(promotion, usage[promotion.id] ?? { reserved: 0, redeemed: 0, released: 0, manualReview: 0 }) });
    response.headers.set("ETag", promotionEtag(promotion));
    return response;
  }, runtime);
}

export function createAdminPromotionRedemptionHistoryRoute(runtime: () => Runtime = getRuntime) {
  return adminApiRoute(async (request) => {
    if (request.method !== "GET") throw new AppError(405, "method_not_allowed", "Coupon redemption history is read-only.");
    const promotionId = couponIdFromRequest(request);
    const current = runtime();
    const promotion = await current.repo.getPromotion(promotionId);
    if (!promotion || (promotion.type !== "discount_coupon" && promotion.type !== "free_access_coupon")) throw new AppError(404, "not_found", "Coupon was not found.");
    const { page, pageSize, skip } = parseHistoryPage(request);
    const result = await current.repo.listPromotionRedemptionHistory(promotionId, { skip, take: pageSize });
    return json({ data: result.items.map((row) => ({ id: row.id, status: row.status, userDisplayIdentifier: row.userId, planId: row.planId, interval: row.interval, listPricePaise: row.listPricePaise, discountPaise: row.discountPaise, payablePaise: row.payablePaise, currency: row.currency, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })), page, pageSize, total: result.total });
  }, runtime);
}

export function createAdminPromotionLifecycleHistoryRoute(runtime: () => Runtime = getRuntime) {
  return adminApiRoute(async (request) => {
    if (request.method !== "GET") throw new AppError(405, "method_not_allowed", "Coupon lifecycle history is read-only.");
    const promotionId = couponIdFromRequest(request);
    const current = runtime();
    const promotion = await current.repo.getPromotion(promotionId);
    if (!promotion || (promotion.type !== "discount_coupon" && promotion.type !== "free_access_coupon")) throw new AppError(404, "not_found", "Coupon was not found.");
    const { page, pageSize, skip } = parseHistoryPage(request);
    const result = await current.repo.listPromotionLifecycleHistory(promotionId, { skip, take: pageSize });
    return json({ data: result.items.map((event) => ({ id: event.id, eventType: event.eventType, subjectUserId: event.subjectUserId, actorUserId: event.actorUserId, redemptionId: event.redemptionId, accessGrantId: event.accessGrantId, occurredAt: event.occurredAt.toISOString(), outcome: event.outcome, auditUrl: event.auditId ? `/admin/audit/${encodeURIComponent(event.auditId)}` : null })), page, pageSize, total: result.total });
  }, runtime);
}

function promotionEtag(record: PromotionRecord): string {
  return `"${record.updatedAt.toISOString()}"`;
}

export function createAdminPromotionUpdateRoute(runtime: () => Runtime = getRuntime) {
  return adminApiRoute(async (request, adminId) => {
    if (request.method !== "PUT") throw new AppError(405, "method_not_allowed", "This coupon endpoint supports PUT only.");
    const encodedId = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    let promotionId: string;
    try { promotionId = decodeURIComponent(encodedId); } catch { throw new AppError(400, "invalid_promotion_id", "Coupon identifier is invalid."); }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(promotionId)) throw new AppError(400, "invalid_promotion_id", "Coupon identifier is invalid.");
    const current = runtime();
    const existing = await current.repo.getPromotion(promotionId);
    if (!existing) throw new AppError(404, "not_found", "Coupon was not found.");
    if (existing.status !== "draft") throw new AppError(409, "coupon_not_editable", "Only draft coupons can be edited.");

    const ifMatch = request.headers.get("if-match");
    if (!ifMatch) throw new AppError(428, "precondition_required", "Reload this coupon before saving changes.");
    if (ifMatch !== promotionEtag(existing)) throw new AppError(409, "stale_coupon", "This coupon changed since it was loaded. Reload it and try again.");

    const parsed = await readSmallJson(request);
    if (!parsed.ok) throw new AppError(parsed.status, parsed.error, "Coupon request could not be read.");
    const candidate = parseCoupon(parsed.value, adminId, existing.id, current.now());
    if (candidate.type !== existing.type) throw new AppError(400, "coupon_type_immutable", "A coupon's discount or access type cannot be changed after creation.");
    // Identity and provenance are inherited from the stored row, never accepted from request data.
    candidate.createdByAdminId = existing.createdByAdminId;
    candidate.createdAt = existing.createdAt;
    candidate.status = "draft";
    const result = await current.repo.updateDraftPromotion({ record: candidate, expectedUpdatedAt: existing.updatedAt, actorUserId: adminId });
    if (result.status === "missing") throw new AppError(404, "not_found", "Coupon was not found.");
    if (result.status === "target_user_missing") throw new AppError(400, "invalid_target_user", "The selected target user does not exist.");
    if (result.status === "not_draft") throw new AppError(409, "coupon_not_editable", "Only draft coupons can be edited.");
    if (result.status === "stale") throw new AppError(409, "stale_coupon", "This coupon changed since it was loaded. Reload it and try again.");
    if (result.status === "history") throw new AppError(409, "coupon_has_history", "Coupons with redemption or access history cannot be edited.");
    if (result.status !== "updated") throw new AppError(409, "coupon_conflict", "Coupon could not be updated because its code or stored definition conflicts with another record.");
    const usage = await current.repo.getPromotionUsageCounts([result.promotion.id]);
    const response = json({ data: couponDto(result.promotion, usage[result.promotion.id] ?? { reserved: 0, redeemed: 0, released: 0, manualReview: 0 }) });
    response.headers.set("ETag", promotionEtag(result.promotion));
    return response;
  }, runtime);
}

export function createAdminPromotionStatusRoute(runtime: () => Runtime = getRuntime) {
  return adminApiRoute(async (request, adminId) => {
    if (request.method !== "PATCH") throw new AppError(405, "method_not_allowed", "This coupon status endpoint supports PATCH only.");
    const encodedId = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    let promotionId: string;
    try { promotionId = decodeURIComponent(encodedId); } catch { throw new AppError(400, "invalid_promotion_id", "Coupon identifier is invalid."); }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(promotionId)) throw new AppError(400, "invalid_promotion_id", "Coupon identifier is invalid.");
    const current = runtime();
    const existing = await current.repo.getPromotion(promotionId);
    if (!existing) throw new AppError(404, "not_found", "Coupon was not found.");
    const ifMatch = request.headers.get("if-match");
    if (!ifMatch) throw new AppError(428, "precondition_required", "Reload this coupon before changing its status.");
    if (ifMatch !== promotionEtag(existing)) throw new AppError(409, "stale_coupon", "This coupon changed since it was loaded. Reload it and try again.");
    const parsed = await readSmallJson(request);
    if (!parsed.ok) throw new AppError(parsed.status, parsed.error, "Coupon status request could not be read.");
    if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) throw new AppError(400, "invalid_coupon_action", "Choose an explicit coupon action.");
    const body = parsed.value as Record<string, unknown>;
    if (Object.keys(body).length !== 1 || (body.action !== "activate" && body.action !== "deactivate")) throw new AppError(400, "invalid_coupon_action", "Choose activate or deactivate only.");
    const activating = body.action === "activate";
    const expectedStatus = activating ? "draft" : "active";
    const nextStatus = activating ? "active" : "paused";
    if (existing.type !== "discount_coupon" && existing.type !== "free_access_coupon") throw new AppError(409, "not_coupon", "Only coupons can be activated or deactivated here.");
    if (existing.status !== expectedStatus) throw new AppError(409, "invalid_coupon_status", activating ? "Only draft coupons can be activated." : "Only active coupons can be deactivated.");
    const result = await current.repo.transitionCouponStatus({ id: promotionId, expectedStatus, nextStatus, expectedUpdatedAt: existing.updatedAt, actorUserId: adminId, now: current.now() });
    if (result.status === "missing") throw new AppError(404, "not_found", "Coupon was not found.");
    if (result.status === "not_coupon") throw new AppError(409, "not_coupon", "Only coupons can be activated or deactivated here.");
    if (result.status === "invalid_status") throw new AppError(409, "invalid_coupon_status", activating ? "Only draft coupons can be activated." : "Only active coupons can be deactivated.");
    if (result.status === "stale") throw new AppError(409, "stale_coupon", "This coupon changed since it was loaded. Reload it and try again.");
    if (result.status !== "updated") throw new AppError(409, "coupon_conflict", "Coupon status could not be changed.");
    const usage = await current.repo.getPromotionUsageCounts([result.promotion.id]);
    const response = json({ data: couponDto(result.promotion, usage[result.promotion.id] ?? { reserved: 0, redeemed: 0, released: 0, manualReview: 0 }) });
    response.headers.set("ETag", promotionEtag(result.promotion));
    return response;
  }, runtime);
}
