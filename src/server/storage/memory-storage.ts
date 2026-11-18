// In-memory storage for demo mode and tests. Bytes vanish when the server restarts - the UI says so.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  async statSize(key: string): Promise<number | null> { parseStorageKey(key); return this.objects.get(key)?.length ?? this.staged.get(key)?.length ?? null; }
  async getPrivateMetadata(key: string) { const sizeBytes = await this.statSize(key); return sizeBytes === null ? null : { sizeBytes, storageKind: this.kind }; }
  async openRead(key: string, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array>> {
    parseStorageKey(key);
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error("No such object.");
    const slice = range ? bytes.slice(range.start, range.end + 1) : bytes.slice();
    return new Response(slice).body as ReadableStream<Uint8Array>;
  }
  async deleteUnreferencedUpload(finalKey: string): Promise<void> { parseStorageKey(finalKey); this.objects.delete(finalKey); }
  async deleteCommittedMediaObject(key: string): Promise<void> { parseStorageKey(key); this.objects.delete(key); }
  async runWithCommittedFile<T>(key: string, work: (filePath: string) => Promise<T>): Promise<T> {
    parseStorageKey(key);
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error("No such object.");
    const dir = await mkdtemp(path.join(tmpdir(), "clipforge-object-"));
    try { const file = path.join(dir, "object.bin"); await writeFile(file, bytes, { mode: 0o600 }); return await work(file); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
  async importLocalFile(finalKey: string, sourcePath: string): Promise<number> {
    parseStorageKey(finalKey);
    if (this.objects.has(finalKey)) throw new Error("An object already exists under that key.");
    const bytes = await readFile(sourcePath);
    this.objects.set(finalKey, bytes);
    return bytes.length;
  }
  async copyCommittedToStaging(sourceKey: string, stagingKey: string, assertLease?: () => void): Promise<number> {
    assertLease?.();
    parseStorageKey(sourceKey); parseStorageKey(stagingKey);
    const bytes = this.objects.get(sourceKey);
    if (!bytes) throw new Error("No such object.");
    if (this.staged.has(stagingKey)) throw new Error("An object already exists under that key.");
    this.staged.set(stagingKey, bytes.slice());
    return bytes.byteLength;
  }
}
