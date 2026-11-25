import assert from "node:assert/strict";
import test from "node:test";
import { GET as live } from "../app/api/health/live/route.ts";
import { GET as ready } from "../app/api/health/ready/route.ts";
import { createLocalRuntime, setRuntimeForTests, type Runtime } from "../src/server/runtime.ts";

test("liveness responds without initializing application dependencies", async () => {
  const response = live();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("readiness succeeds only when safe dependency checks pass", async () => {
  const base = createLocalRuntime();
  const runtime: Runtime = { ...base, mode: "database", checkReadiness: async () => undefined };
  setRuntimeForTests(runtime);
  try {
    const response = await ready();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally { setRuntimeForTests(null); }
});

test("readiness failure is generic and does not expose dependency details", async () => {
  const base = createLocalRuntime();
  const runtime: Runtime = { ...base, mode: "database", checkReadiness: async () => { throw new Error("private database host and password"); } };
  setRuntimeForTests(runtime);
  try {
    const response = await ready();
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), { status: "not_ready" });
    assert.equal(body.includes("private database"), false);
  } finally { setRuntimeForTests(null); }
});

test("readiness refuses non-database runtime modes without disclosing configuration", async () => {
  setRuntimeForTests(createLocalRuntime());
  try {
    const response = await ready();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "not_ready" });
  } finally { setRuntimeForTests(null); }
});
