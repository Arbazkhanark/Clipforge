import { AsyncLocalStorage } from "node:async_hooks";

// Next.js 16 expects AsyncLocalStorage to be exposed globally by its server runtime.
// Plain Node test rendering does not run that bootstrap, so install the Node primitive
// before loading Next's request-context stores.
const runtimeGlobal = globalThis as typeof globalThis & {
  AsyncLocalStorage?: typeof AsyncLocalStorage;
};
runtimeGlobal.AsyncLocalStorage ??= AsyncLocalStorage;

const [{ workAsyncStorage }, { workUnitAsyncStorage }] = await Promise.all([
  import("next/dist/server/app-render/work-async-storage.external.js"),
  import("next/dist/server/app-render/work-unit-async-storage.external.js"),
]);

/** Render a server component under a minimal dynamic request context in plain Node. */
export function runWithNextRequestScope<T>(render: () => T): T {
  const workStore = {
    route: "/",
    forceStatic: true,
  } as Parameters<typeof workAsyncStorage.run>[0];
  const requestStore = {
    type: "request",
    phase: "render",
    headers: new Headers(),
  } as Parameters<typeof workUnitAsyncStorage.run>[0];

  return workAsyncStorage.run(workStore, () =>
    workUnitAsyncStorage.run(requestStore, render),
  );
}
