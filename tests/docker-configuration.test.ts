import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
const dockerignore = await readFile(new URL("../.dockerignore", import.meta.url), "utf8");
const adminPreviewServer = await readFile(new URL("../src/server/admin/admin-preview-server.ts", import.meta.url), "utf8");
const pageCookies = await readFile(new URL("../src/server/auth/page-cookies.ts", import.meta.url), "utf8");
const instagramPage = await readFile(new URL("../app/(app)/instagram/page.tsx", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const packageLock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8")) as {
  packages: Record<string, { version?: string; dependencies?: Record<string, string>; resolved?: string }>;
};
const workerRuntimePackage = JSON.parse(await readFile(new URL("../docker/worker-runtime/package.json", import.meta.url), "utf8")) as {
  name: string;
  type: string;
  dependencies: Record<string, string>;
};
const workerRuntimeLock = JSON.parse(await readFile(new URL("../docker/worker-runtime/package-lock.json", import.meta.url), "utf8")) as {
  lockfileVersion: number;
  packages: Record<string, { version?: string; dependencies?: Record<string, string>; resolved?: string }>;
};
const nextConfig = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
const awsDockerPreparation = await readFile(new URL("../docs/AWS_DOCKER_PREPARATION.md", import.meta.url), "utf8");

test("production container targets map to the existing continuous-worker entrypoints", () => {
  for (const [target, entrypoint] of [
    ["worker-media-verification", "scripts/run-media-verification-worker.ts"],
    ["worker-media-cleanup", "scripts/run-media-cleanup-worker.ts"],
    ["worker-media-replacement", "scripts/run-media-replacement-worker.ts"],
    ["worker-render", "scripts/run-render-worker.ts"],
    ["worker-instagram-publishing", "scripts/run-publishing-worker.ts"],
  ]) {
    assert.ok(dockerfile.includes(`AS ${target}`), `missing Docker target ${target}`);
    assert.ok(dockerfile.includes(`"${entrypoint}"`), `missing worker entrypoint ${entrypoint}`);
  }
  assert.match(dockerfile, /STOPSIGNAL SIGTERM/);
  assert.match(dockerfile, /CLIPFORGE_DEPLOYMENT_ENV=production/);
  assert.match(dockerfile, /CLIPFORGE_STORAGE_PROVIDER=s3/);
  assert.match(dockerfile, /node:22\.23\.5-bookworm-slim/);
  assert.match(dockerfile, /COPY --from=worker-runtime-deps [^\n]*\/app\/package\.json/);
  assert.match(dockerfile, /COPY --from=builder [^\n]*\/app\/tsconfig\.json/);
  assert.match(dockerfile, /AS build-deps[\s\S]*?apt-get install[^\n]*openssl/);
  assert.match(dockerfile, /AS runtime-base[\s\S]*?apt-get install[^\n]*openssl/);
  assert.ok(packageJson.dependencies.tsx, "tsx must be installed in production worker images");
});

test("web target uses standalone Next output, non-root runtime and liveness health check", () => {
  assert.match(nextConfig, /CLIPFORGE_CONTAINER_BUILD[\s\S]*output:\s*["']standalone["']/);
  assert.match(nextConfig, /outputFileTracingExcludes[\s\S]*["']\/\*["'][\s\S]*node_modules\/nodemailer/);
  assert.match(dockerfile, /CLIPFORGE_CONTAINER_BUILD=true/);
  assert.match(dockerfile, /AS web[\s\S]*?USER node[\s\S]*?HEALTHCHECK[\s\S]*?\/api\/health\/live[\s\S]*?CMD \["node", "server\.js"\]/);
  assert.match(dockerfile, /TMPDIR=\/tmp\/clipforge/);
  assert.match(dockerfile, /COPY --from=builder [^\n]*\/app\/src\/generated\/prisma/);
  assert.match(awsDockerPreparation, /CLIPFORGE_EXPECTED_DATABASE_PORT/);
});

test("Nodemailer stays available to development but is excluded from production dependency packaging", () => {
  assert.equal(packageJson.dependencies.nodemailer, undefined);
  assert.equal(packageJson.devDependencies.nodemailer, "10.6.1");
  assert.match(dockerfile, /AS worker-runtime-deps[\s\S]*?npm ci --omit=dev --omit=peer --ignore-scripts/);
  assert.doesNotMatch(dockerfile, /npm prune/);
  assert.match(nextConfig, /outputFileTracingExcludes[\s\S]*["']\/\*["'][\s\S]*node_modules\/nodemailer\/\*\*/);
});

test("worker runtime uses an independent version-aligned lock without CLI or email tooling", () => {
  assert.equal(workerRuntimePackage.name, "clipforge-worker-runtime");
  assert.equal(workerRuntimePackage.type, "module");
  assert.equal(workerRuntimeLock.lockfileVersion, 3);
  assert.deepEqual(workerRuntimeLock.packages[""]?.dependencies, workerRuntimePackage.dependencies);

  for (const [name, version] of Object.entries(workerRuntimePackage.dependencies)) {
    assert.equal(packageLock.packages[`node_modules/${name}`]?.version, version, `${name} must match the root locked version`);
    assert.equal(workerRuntimeLock.packages[`node_modules/${name}`]?.version, version, `${name} must match the worker runtime lock`);
  }
  for (const required of ["@prisma/client", "@prisma/adapter-pg", "pg", "tsx", "next", "react", "react-dom", "@aws-sdk/client-s3", "@aws-sdk/credential-provider-node"]) {
    assert.ok(workerRuntimePackage.dependencies[required], `worker runtime must include ${required}`);
  }
  for (const excluded of ["prisma", "@prisma/config", "@prisma/dev", "effect", "nodemailer"]) {
    assert.equal(workerRuntimePackage.dependencies[excluded], undefined, `${excluded} must not be a direct worker dependency`);
    assert.equal(workerRuntimeLock.packages[`node_modules/${excluded}`], undefined, `${excluded} must not be in the worker lockfile`);
  }
  for (const optional of ["@esbuild/linux-arm64", "@next/swc-linux-arm64-gnu", "@img/sharp-linux-arm64", "@img/sharp-libvips-linux-arm64", "@img/sharp-wasm32", "@emnapi/runtime"]) {
    assert.ok(workerRuntimeLock.packages[`node_modules/${optional}`], `${optional} must remain in the lockfile`);
  }
  for (const entry of Object.values(workerRuntimeLock.packages)) {
    if (entry.resolved) assert.equal(new URL(entry.resolved).hostname, "registry.npmjs.org");
  }
});

test("worker packaging installs the dedicated dependency tree and includes generated Prisma output", () => {
  assert.match(dockerfile, /FROM node:22\.23\.5-bookworm-slim AS worker-runtime-deps[\s\S]*?COPY docker\/worker-runtime\/package\.json docker\/worker-runtime\/package-lock\.json \.\/[\s\S]*?RUN npm ci --omit=dev --omit=peer --ignore-scripts/);
  assert.match(dockerfile, /COPY --from=worker-runtime-deps --chown=node:node \/app\/node_modules \.\/node_modules/);
  assert.match(dockerfile, /COPY --from=builder --chown=node:node \/app\/src \.\/src/);
  assert.match(dockerfile, /RUN npm run build[\s\S]*?COPY --from=builder --chown=node:node \/app\/src \.\/src/);
});

test("production sources do not depend on excluded tests and use NodeNext-compatible Next imports", () => {
  assert.match(adminPreviewServer, /from ["']\.\/admin-preview-data\.ts["']/);
  assert.doesNotMatch(adminPreviewServer, /from ["'][^"']*tests\//);
  assert.match(pageCookies, /import\(["']next\/headers\.js["']\)/);
  assert.match(instagramPage, /from ["']next\/headers\.js["']/);
});

test("build context excludes credentials and local persistent media", () => {
  for (const excluded of [".env*", ".aws/", ".npmrc", ".local-media/", ".local-node/", "node_modules/", ".next/"]) {
    assert.ok(dockerignore.includes(excluded), `missing Docker context exclusion ${excluded}`);
  }
  assert.doesNotMatch(dockerfile, /^\s*ARG\s+(?:DATABASE_URL|DIRECT_URL|AWS_|.*SECRET|.*TOKEN)/m);
  assert.doesNotMatch(dockerfile, /^\s*ENV\s+(?:DATABASE_URL|DIRECT_URL|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|.*SECRET|.*TOKEN)=/m);
  assert.match(dockerfile, /COPY prisma\/schema\.prisma[^\n]*\nCOPY prisma\.config\.ts[^\n]*\n[\s\S]*RUN npm ci/);
  assert.match(dockerfile, /COPY src\/server\/workers\/database-identity-guard\.ts \.\/src\/server\/workers\/database-identity-guard\.ts/);
});

test("worker targets retain their required FFmpeg and ffprobe executables", () => {
  const targets = new Map<string, string>();
  for (const [target, start] of [
    ["web", /FROM runtime-base AS web/],
    ["worker-media-verification", /FROM worker-runtime AS worker-media-verification/],
    ["worker-media-cleanup", /FROM worker-runtime AS worker-media-cleanup/],
    ["worker-media-replacement", /FROM worker-runtime AS worker-media-replacement/],
    ["worker-render", /FROM worker-runtime AS worker-render/],
    ["worker-instagram-publishing", /FROM worker-runtime AS worker-instagram-publishing/],
  ] as const) {
    const startIndex = dockerfile.search(start);
    const nextIndex = dockerfile.indexOf("\nFROM ", startIndex + 1);
    targets.set(target, dockerfile.slice(startIndex, nextIndex < 0 ? undefined : nextIndex));
  }
  assert.match(targets.get("web") ?? "", /apt-get install -y --no-install-recommends ffmpeg/);
  for (const name of ["worker-media-verification", "worker-media-replacement"]) {
    assert.match(targets.get(name) ?? "", /apt-get install -y --no-install-recommends ffmpeg/);
    assert.match(targets.get(name) ?? "", /command -v ffprobe/);
    assert.match(targets.get(name) ?? "", /rm \/usr\/bin\/ffmpeg/);
    assert.match(targets.get(name) ?? "", /! command -v ffmpeg/);
  }
  assert.match(targets.get("worker-render") ?? "", /apt-get install -y --no-install-recommends ffmpeg/);
  for (const name of ["worker-media-cleanup", "worker-instagram-publishing"]) {
    assert.doesNotMatch(targets.get(name) ?? "", /apt-get install[^\n]*ffmpeg/);
  }
});
