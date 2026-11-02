// MINIMAL stand-ins for @types/node and @types/react, used ONLY when the real packages are not installed (see tests/typecheck.test.ts).
// They check that OUR code connects together (imports, props of our own components, strict null handling).
// They do NOT check HTML/DOM attribute names or the real Node/React APIs - the real `npm run typecheck` does, after `npm install`.
declare module "node:crypto" {
  export function randomBytes(n: number): { toString(enc: string): string };
  export function createHash(a: string): { update(s: string): { digest(enc: string): string } };
}
declare module "node:crypto" { export function createHmac(a: string, k: string): { update(d: unknown): { digest(e: string): string } }; export function timingSafeEqual(a: unknown, b: unknown): boolean; }
declare const Buffer: any; type Buffer = any;
declare function structuredClone<T>(v: T): T;
declare const process: { env: Record<string, string | undefined>; cwd(): string };
declare module "node:child_process" { export function spawn(c: string, a: string[], o?: unknown): { on(ev: string, cb: (...args: any[]) => void): any; kill(signal?: string): boolean; stdout: { on(ev: string, cb: (d: any) => void): any }; stderr: { on(ev: string, cb: (d: any) => void): any } }; }
declare module "node:fs/promises" { export const mkdtemp: any, writeFile: any, rm: any, mkdir: any, realpath: any, open: any, chmod: any, link: any, unlink: any, lstat: any; export function stat(p: string): Promise<{ isFile(): boolean; mode: number }>; }
declare module "node:os" { export const tmpdir: () => string; }
declare module "node:path" { const p: any; export default p; }
declare class File { name: string; type: string; arrayBuffer(): Promise<ArrayBuffer>; }
declare module "node:fs" { export function createReadStream(p: string, o?: unknown): any; }
declare module "node:stream" { export const Readable: { toWeb(s: unknown): unknown }; }
declare module "node:crypto" {
  export function randomBytes(n: number): Uint8Array & { toString(enc: string): string };
  export function createHash(a: string): { update(s: string): { digest(enc: string): string } };
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  export function scrypt(pw: string, salt: Uint8Array, len: number, opts: { N: number; r: number; p: number; maxmem: number }, cb: (e: Error | null, key: Uint8Array) => void): void;
}
declare const Buffer: { from(v: any, enc?: string): Uint8Array & { toString(enc: string): string; length: number } };
declare function structuredClone<T>(v: T): T;
declare module "node:crypto" { export function randomUUID(): string; }
declare module "next/headers" { export function headers(): Promise<{ get(name: string): string | null }>; }
// MINIMAL stand-ins for @types/react: component props of OUR OWN components are still checked; HTML attributes are not.
declare module "react" {
  export type ReactNode = any;
  export function useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
}
declare module "react/jsx-runtime" {
  export namespace JSX {
    type Element = any;
    type ElementType = any;
    interface IntrinsicElements { [name: string]: any }
    interface ElementChildrenAttribute { children: {} }
    interface IntrinsicAttributes { key?: any }
  }
  export const jsx: any; export const jsxs: any; export const Fragment: any;
}
declare module "react-dom/server" { export function renderToStaticMarkup(node: any): string; }
declare module "next/headers" { export function headers(): Promise<{ get(name: string): string | null }>; }
declare const document: any; declare class HTMLFormElement { elements: any } declare class HTMLInputElement { value: string } declare class SVGGraphicsElement { dataset: any; setAttribute(n: string, v: string): void; addEventListener(n: string, f: any): void; removeEventListener(n: string, f: any): void; setPointerCapture(id: number): void } declare class PointerEvent { clientX: number; clientY: number; pointerId: number } declare class SVGSVGElement { getBoundingClientRect(): any; viewBox: any; querySelector(s: string): any }
