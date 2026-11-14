import test from "node:test";
import assert from "node:assert/strict";
import { canShowTrialReminder, formatTrialRemaining, isActiveTrial, TRIAL_REMINDER_COOLDOWN_MS } from "../src/lib/ui/trial-reminder.ts";

test("trial reminder only accepts a real, active authenticated trial end", () => {
  assert.equal(isActiveTrial("authenticated", 2_000, 1_000), true);
  assert.equal(isActiveTrial("authenticated", null, 1_000), false);
  assert.equal(isActiveTrial("authenticated", 1_000, 1_000), false);
  assert.equal(isActiveTrial("active", 2_000, 1_000), false);
  assert.equal(isActiveTrial("authenticated", Number.MAX_SAFE_INTEGER, 1_000), false);
});

test("trial reminder cooldown is ten hours", () => {
  const now = 100_000_000;
  assert.equal(TRIAL_REMINDER_COOLDOWN_MS, 10 * 60 * 60 * 1000);
  assert.equal(canShowTrialReminder(null, now), true);
  assert.equal(canShowTrialReminder(now - TRIAL_REMINDER_COOLDOWN_MS + 1, now), false);
  assert.equal(canShowTrialReminder(now - TRIAL_REMINDER_COOLDOWN_MS, now), true);
});

test("trial duration is formatted from the actual remaining milliseconds", () => {
  assert.equal(formatTrialRemaining(60_000), "1 minute remaining");
  assert.equal(formatTrialRemaining(3_600_000), "1 hour remaining");
  assert.equal(formatTrialRemaining(25 * 3_600_000), "1 day, 1 hour remaining");
});
