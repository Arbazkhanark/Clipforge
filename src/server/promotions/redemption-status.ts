import { checkSameOrigin } from "../http.ts";
import { getRuntime, type Runtime } from "../runtime.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Returns only the authenticated owner's persisted coupon, payment-intent and grant status. */
export function createPromotionRedemptionStatusRoute(runtime: () => Runtime = getRuntime): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      const crossSite = checkSameOrigin(request);
      if (crossSite) return json({ error: "cross_site_request" }, 403);
      const origin = request.headers.get("origin");
      if (origin !== null) {
        try { if (new URL(origin).origin !== new URL(request.url).origin) return json({ error: "cross_site_request" }, 403); }
        catch { return json({ error: "cross_site_request" }, 403); }
      }
      const current = runtime();
      const userId = await current.currentUserId(request);
      if (!userId) return json({ error: "unauthenticated" }, 401);
      const encodedId = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
      let redemptionId: string;
      try { redemptionId = decodeURIComponent(encodedId); } catch { return json({ error: "not_found" }, 404); }
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(redemptionId)) return json({ error: "not_found" }, 404);
      const status = await current.repo.getUserPromotionRedemptionStatus(userId, redemptionId);
      if (!status) return json({ error: "not_found" }, 404);
      const now = current.now();
      return json({ data: {
        redemption: { id: status.redemption.id, status: status.redemption.status, planId: status.redemption.planId, interval: status.redemption.interval, listPricePaise: status.redemption.listPricePaise, discountPaise: status.redemption.discountPaise, payablePaise: status.redemption.payablePaise, currency: status.redemption.currency, redeemedAt: status.redemption.redeemedAt?.toISOString() ?? null, createdAt: status.redemption.createdAt.toISOString(), updatedAt: status.redemption.updatedAt.toISOString() },
        coupon: { status: status.coupon.status, unavailable: status.coupon.status !== "active" || status.coupon.startsAt > now || (status.coupon.expiresAt !== null && status.coupon.expiresAt <= now) },
        manualPayment: status.manualPayment ? { status: status.manualPayment.status, accessStartsAt: status.manualPayment.accessStartsAt?.toISOString() ?? null, accessEndsAt: status.manualPayment.accessEndsAt?.toISOString() ?? null } : null,
        grant: status.grant ? { status: status.grant.status, planId: status.grant.planId, startsAt: status.grant.startsAt?.toISOString() ?? null, expiresAt: status.grant.expiresAt?.toISOString() ?? null } : null,
      } });
    } catch {
      return json({ error: "promotion_status_unavailable" }, 503);
    }
  };
}
