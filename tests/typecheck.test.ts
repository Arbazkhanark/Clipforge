// A PARTIAL strict TypeScript check (src/ and app/, including every .tsx file) using minimal type stubs, for environments where
// the real @types packages cannot be installed. It already caught a real bug (an HTMLElement used as an SVGSVGElement).
// Excluded because they need packages we cannot install here: src/server/prisma/create-client.ts and prisma.config.ts.
// Once `npm install` has run, this test steps aside and the REAL `npm run typecheck` (which also covers tests/) is the check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const realTypesInstalled = existsSync(new URL("../node_modules/@types/react", import.meta.url)) || existsSync(new URL("../node_modules/@types/node", import.meta.url));
const tscAvailable = spawnSync("tsc", ["--version"]).status === 0;

test("partial strict typecheck of src/ and app/ (with .tsx) passes", { skip: realTypesInstalled ? "real @types installed: use `npm run typecheck`" : !tscAvailable ? "tsc not available" : false }, () => {
  const result = spawnSync("tsc", ["-p", new URL("./typecheck/tsconfig.partial.json", import.meta.url).pathname], { encoding: "utf8" });
  assert.equal(result.status, 0, `tsc reported errors:\n${result.stdout}${result.stderr}`);
});
