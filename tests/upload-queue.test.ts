import assert from "node:assert/strict";
import test from "node:test";
import { retryableUploads, runBoundedUploads, UploadRunGuard } from "../src/components/upload-queue.ts";

test("bounded upload runner caps concurrency and continues after an individual failure", async () => {
  const items = ["first", "second", "third", "fourth"];
  const complete: string[] = [];
  let active = 0;
  let peak = 0;
  await runBoundedUploads(items, 2, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    if (item === "second") throw new Error("synthetic failure");
    complete.push(item);
  });
  assert.equal(peak, 2);
  assert.deepEqual(complete.sort(), ["first", "fourth", "third"]);
});

test("retry selection contains only failed pending files, never completed files", () => {
  const rows = [
    { id: "ok", status: "complete" },
    { id: "bad", status: "failed" },
    { id: "waiting", status: "queued" },
  ];
  assert.deepEqual(retryableUploads(rows).map((row) => row.id), ["bad"]);
  assert.deepEqual(retryableUploads([{ id: "uncertain", status: "failed", uncertain: true }]), []);
});

test("upload run guard rejects duplicate submissions until the active batch finishes", () => {
  const guard = new UploadRunGuard();
  assert.equal(guard.begin(), true);
  assert.equal(guard.begin(), false);
  guard.end();
  assert.equal(guard.begin(), true);
});

test("bounded upload runner rejects invalid concurrency without starting work", async () => {
  let started = false;
  await assert.rejects(runBoundedUploads(["one"], 0, async () => { started = true; }), RangeError);
  assert.equal(started, false);
});
