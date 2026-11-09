import { normalizePromotionCode } from "../../lib/domain/promotions.ts";
import { checkSameOrigin } from "../http.ts";
import { getRuntime, type Runtime } from "../runtime.ts";
import { readSmallJson } from "../billing/request-json.ts";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

/** Authenticated, one-time free-access coupon redemption. The request body accepts only { code }. */
export function createFreeAccessCouponRedemptionRoute(runtime: () => Runtime = getRuntime): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const current = runtime();
      const crossSite = checkSameOrigin(request);
      if (crossSite) return json({ error: "cross_site_request" }, 403);
      const userId = await current.currentUserId(request);
      if (!userId) return json({ error: "unauthenticated" }, 401);

      const parsed = await readSmallJson(request);
      if (!parsed.ok) return json({ error: "invalid_coupon_request" }, parsed.status);
      if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return json({ error: "invalid_coupon_request" }, 400);
      const body = parsed.value as Record<string, unknown>;
      if (Object.keys(body).length !== 1 || typeof body.code !== "string") return json({ error: "invalid_coupon_request" }, 400);

      const code = normalizePromotionCode(body.code);
      if (!/^[A-Z0-9_-]{3,64}$/.test(code)) return json({ error: "invalid_coupon_code" }, 400);
      const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
      if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return json({ error: "invalid_idempotency_key" }, 400);

      const result = await current.repo.redeemFreeAccessCoupon({
        redemptionId: current.newId(), grantId: current.newId(), userId, code, idempotencyKey, now: current.now(),
      });
      if (!("redemption" in result)) {
        return result.status === "unavailable"
          ? json({ error: "coupon_unavailable" }, 409)
          : json({ error: "coupon_redemption_conflict" }, 409);
      }
      const grant = result.grant;
      return json({
        data: {
          redemption: { id: result.redemption.id, status: result.redemption.status, redeemedAt: result.redemption.redeemedAt?.toISOString() ?? null },
          grant: {
            id: grant.id, planId: grant.planId, durationDays: grant.durationDays, status: grant.status,
            activationPolicy: grant.activationPolicy, startsAt: grant.startsAt?.toISOString() ?? null, expiresAt: grant.expiresAt?.toISOString() ?? null,
          },
        },
        idempotentReplay: result.status === "existing",
      }, result.status === "created" ? 201 : 200);
    } catch {
      // Do not leak auth/repository/Prisma details. A transaction failure leaves no redemption or grant committed.
      return json({ error: "coupon_redemption_unavailable" }, 503);
    }
  };
}
