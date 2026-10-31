// Private local-disk storage for DEVELOPMENT ONLY. Files live under one root folder that must be OUTSIDE
// anything the web server serves (public/, .next/, app/). Nothing here is reachable by URL: the only way
// to read a file is through authorised server code.
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { chmod, link, lstat, mkdir, open, realpath, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { InvalidStorageKeyError, parseStorageKey, type MediaStorage } from "./media-storage.ts";

export class LocalDiskMediaStorage implements MediaStorage {
  readonly kind = "local-disk" as const;
  private rootReal: string;

  private constructor(rootReal: string) { this.rootReal = rootReal; }

  /** Creates the root folder (private, mode 0700) and refuses roots inside web-served folders. */
  static async create(rootDir: string, forbiddenParents: string[] = [path.join(process.cwd(), "public"), path.join(process.cwd(), ".next"), path.join(process.cwd(), "app")]): Promise<LocalDiskMediaStorage> {
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    const rootReal = await realpath(rootDir);
    for (const forbidden of forbiddenParents) {
      const forbiddenReal = await realpath(forbidden).catch(() => path.resolve(forbidden));
      const relative = path.relative(forbiddenReal, rootReal);
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) throw new Error("The media folder must not be inside a web-served folder.");
    }
    return new LocalDiskMediaStorage(rootReal);
  }

  /** Turns a validated key into a path INSIDE the root. Checks the real location too, so symlinks cannot escape. */
  private async resolveInside(key: string, createParents: boolean): Promise<string> {
    const segments = parseStorageKey(key);
    const target = path.join(this.rootReal, ...segments);
    const parent = path.dirname(target);
    if (createParents) await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentReal = await realpath(parent).catch(() => null);
    const insideRoot = (p: string) => p === this.rootReal || p.startsWith(this.rootReal + path.sep);
    if (parentReal === null ? !insideRoot(path.resolve(parent)) : !insideRoot(parentReal)) throw new InvalidStorageKeyError();
    const existing = await lstat(target).catch(() => null);
    if (existing?.isSymbolicLink()) throw new InvalidStorageKeyError(); // never follow a link planted inside the root
    return target;
  }

  async stage(stagingKey: string, data: Uint8Array): Promise<void> {
    const target = await this.resolveInside(stagingKey, true);
    const handle = await open(target, "wx", 0o600); // "wx": fail instead of overwriting
    try { await handle.writeFile(data); } finally { await handle.close(); }
    await chmod(target, 0o600);
  }

  async runWithStagedFile<T>(stagingKey: string, work: (filePath: string) => Promise<T>): Promise<T> {
    const target = await this.resolveInside(stagingKey, false);
    if (!(await stat(target).then((s) => s.isFile(), () => false))) throw new Error("Nothing is staged under that key.");
    return work(target);
  }

  async commit(stagingKey: string, finalKey: string): Promise<void> {
    const source = await this.resolveInside(stagingKey, false);
    const destination = await this.resolveInside(finalKey, true);
    await link(source, destination); // hard link fails with EEXIST if the destination exists: no silent overwrite
    await unlink(source);
  }

  async discardStaged(stagingKey: string): Promise<void> { await rm(await this.resolveInside(stagingKey, false), { force: true }); }
  async exists(key: string): Promise<boolean> { return stat(await this.resolveInside(key, false)).then((s) => s.isFile(), () => false); }
  async statSize(key: string): Promise<number | null> {
    const target = await this.resolveInside(key, false);
    const info = (await stat(target).then((i) => i, () => null)) as { isFile(): boolean; size: number } | null;
    return info && info.isFile() ? info.size : null;
  }
  async openRead(key: string, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array>> {
    const target = await this.resolveInside(key, false);
    return Readable.toWeb(createReadStream(target, range ? { start: range.start, end: range.end } : {})) as unknown as ReadableStream<Uint8Array>;
  }
  async deleteUnreferencedUpload(finalKey: string): Promise<void> { await rm(await this.resolveInside(finalKey, false), { force: true }); }
}
