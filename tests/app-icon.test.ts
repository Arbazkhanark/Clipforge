// Regression: the browser run (Chromium) logged a 404 because the app had no icon. Next.js serves app/icon.svg automatically.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("app/icon.svg exists, is a plain SVG, and contains no script or external references", () => {
  const svg = readFileSync(new URL("../app/icon.svg", import.meta.url), "utf8");
  assert.match(svg, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(!/<script|onload|onclick|href=|xlink|javascript:/i.test(svg), "icon must be inert");
  assert.ok(svg.length < 2000);
});
