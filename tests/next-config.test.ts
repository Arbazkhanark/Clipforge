import { test } from "node:test";
import assert from "node:assert/strict";
import nextConfig from "../next.config.ts";

test("Next development request logs suppress query credentials but keep ordinary routes visible", () => {
  assert.ok(nextConfig.allowedDevOrigins?.includes("127.0.0.1"));
  const incoming = nextConfig.logging.incomingRequests;
  assert.equal(typeof incoming, "object");
  if (typeof incoming === "boolean") return;
  const ignores = incoming.ignore ?? [];
  const isIgnored = (url: string) => ignores.some((pattern) => pattern.test(url));

  for (const url of [
    "/verify-email?token=one-use",
    "/reset-password?token=one-use",
    "/api/auth/google/callback?code=one-use&state=one-use",
    "/api/instagram/callback?code=one-use&state=one-use",
  ]) assert.equal(isIgnored(url), true);

  for (const url of ["/login", "/dashboard", "/api/auth/login"]) assert.equal(isIgnored(url), false);
});
