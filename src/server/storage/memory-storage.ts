// In-memory storage for demo mode and tests. Bytes vanish when the server restarts - the UI says so.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseStorageKey, type MediaStorage } from "./media-storage.ts";

export class MemoryMediaStorage implements MediaStorage {
  readonly kind = "memory" as const;
  staged = new Map<string, Uint8Array>();
  objects = new Map<string, Uint8Array>();

  async stage(stagingKey: string, data: Uint8Array): Promise<void> {
    parseStorageKey(stagingKey);
    if (this.staged.has(stagingKey)) throw new Error("Staging key already exists.");
    this.staged.set(stagingKey, data.slice());
  }

  async runWithStagedFile<T>(stagingKey: string, work: (filePath: string) => Promise<T>): Promise<T> {
    parseStorageKey(stagingKey);
    const bytes = this.staged.get(stagingKey);
    if (!bytes) throw new Error("Nothing is staged under that key.");
    // ffprobe needs a real file, so write a private temporary copy and always remove it afterwards.
    const dir = await mkdtemp(path.join(tmpdir(), "clipforge-stage-"));
    try { const file = path.join(dir, "upload.bin"); await writeFile(file, bytes, { mode: 0o600 }); return await work(file); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }

  async commit(stagingKey: string, finalKey: string): Promise<void> {
    parseStorageKey(stagingKey); parseStorageKey(finalKey);
    const bytes = this.staged.get(stagingKey);
    if (!bytes) throw new Error("Nothing is staged under that key.");
    if (this.objects.has(finalKey)) throw new Error("An object already exists under that key.");
    this.objects.set(finalKey, bytes); this.staged.delete(stagingKey);
  }

  async discardStaged(stagingKey: string): Promise<void> { parseStorageKey(stagingKey); this.staged.delete(stagingKey); }
  async exists(key: string): Promise<boolean> { parseStorageKey(key); return this.objects.has(key); }
  async deleteUnreferencedUpload(finalKey: string): Promise<void> { parseStorageKey(finalKey); this.objects.delete(finalKey); }
}
