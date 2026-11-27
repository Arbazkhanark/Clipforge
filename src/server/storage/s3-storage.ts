import { createWriteStream } from "node:fs";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { InvalidStorageKeyError, parseStorageKey, type MediaStorage } from "./media-storage.ts";

const NOT_FOUND = new Set(["NotFound", "NoSuchKey"]);

function errorInfo(error: unknown): { name: string; status?: number } {
  if (typeof error !== "object" || error === null) return { name: "StorageError" };
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return {
    name: typeof value.name === "string" ? value.name : "StorageError",
    ...(typeof value.$metadata?.httpStatusCode === "number" ? { status: value.$metadata.httpStatusCode } : {}),
  };
}

function isNotFound(error: unknown): boolean {
  const info = errorInfo(error);
  return info.status === 404 || NOT_FOUND.has(info.name);
}

function copySource(bucket: string, key: string): string {
  return `${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

/** Private S3 implementation of the existing storage contract. No method returns a bucket, key, or URL. */
export class S3MediaStorage implements MediaStorage {
  readonly kind = "s3" as const;

  constructor(private readonly client: S3Client, private readonly bucket: string) {
    if (!bucket || /[^a-z0-9.-]/.test(bucket)) throw new Error("S3 storage configuration is invalid.");
  }

  close(): void { this.client.destroy(); }

  private validate(key: string): void { parseStorageKey(key); }

  async stage(stagingKey: string, data: Uint8Array, metadata: { contentType?: string } = {}): Promise<void> {
    this.validate(stagingKey);
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: stagingKey, Body: data, IfNoneMatch: "*", ...(metadata.contentType ? { ContentType: metadata.contentType } : {}) }));
    } catch (error) {
      if ([409, 412].includes(errorInfo(error).status ?? 0)) throw new Error("An object already exists under that key.");
      throw new Error("Private storage could not save the staged file.", { cause: error });
    }
  }

  async runWithStagedFile<T>(stagingKey: string, work: (filePath: string) => Promise<T>): Promise<T> {
    return this.withDownloadedFile(stagingKey, work, "Nothing is staged under that key.");
  }

  async commit(stagingKey: string, finalKey: string): Promise<void> {
    this.validate(stagingKey); this.validate(finalKey);
    try {
      await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: finalKey, CopySource: copySource(this.bucket, stagingKey), IfNoneMatch: "*" }));
    } catch (error) {
      if ([409, 412].includes(errorInfo(error).status ?? 0)) throw new Error("An object already exists under that key.");
      throw new Error("Private storage could not commit the staged file.", { cause: error });
    }
    // The final object is now committed. A staging cleanup failure must not report the commit as failed;
    // an age-based staging sweep can remove the leftover object after checking active import leases.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: stagingKey })).catch(() => undefined);
  }

  async discardStaged(stagingKey: string): Promise<void> {
    this.validate(stagingKey);
    try { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: stagingKey })); }
    catch { throw new Error("Private storage could not discard the staged file."); }
  }

  async exists(key: string): Promise<boolean> {
    this.validate(key);
    try { await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })); return true; }
    catch (error) { if (isNotFound(error)) return false; throw new Error("Private storage could not check the file."); }
  }

  async statSize(key: string): Promise<number | null> {
    this.validate(key);
    try {
      const response = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return typeof response.ContentLength === "number" && Number.isSafeInteger(response.ContentLength) && response.ContentLength >= 0 ? response.ContentLength : null;
    } catch (error) { if (isNotFound(error)) return null; throw new Error("Private storage could not read file details."); }
  }

  async getPrivateMetadata(key: string) {
    this.validate(key);
    try {
      const response = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return typeof response.ContentLength === "number" && Number.isSafeInteger(response.ContentLength) && response.ContentLength >= 0 ? { sizeBytes: response.ContentLength, storageKind: this.kind, contentType: response.ContentType ?? null } : null;
    } catch (error) { if (isNotFound(error)) return null; throw new Error("Private storage could not read file details."); }
  }

  async openRead(key: string, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array>> {
    this.validate(key);
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket, Key: key,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }));
      if (!response.Body) throw new Error("Private storage returned no file stream.");
      return response.Body.transformToWebStream() as ReadableStream<Uint8Array>;
    } catch { throw new Error("Private storage could not read the file."); }
  }

  async deleteUnreferencedUpload(finalKey: string): Promise<void> {
    this.validate(finalKey);
    try { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: finalKey })); }
    catch { throw new Error("Private storage could not remove the unreferenced upload."); }
  }

  async deleteCommittedMediaObject(key: string): Promise<void> {
    this.validate(key);
    try { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
    catch { throw new Error("Private storage could not permanently remove the media file."); }
  }

  async runWithCommittedFile<T>(key: string, work: (filePath: string) => Promise<T>): Promise<T> {
    return this.withDownloadedFile(key, work, "No such object.");
  }

  private async withDownloadedFile<T>(key: string, work: (filePath: string) => Promise<T>, missingMessage: string): Promise<T> {
    this.validate(key);
    const dir = await mkdtemp(path.join(tmpdir(), "clipforge-s3-"));
    const filePath = path.join(dir, "private-media.bin");
    try {
      let response;
      try { response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })); }
      catch (error) { if (isNotFound(error)) throw new Error(missingMessage); throw new Error("Private storage could not retrieve the file."); }
      if (!response.Body) throw new Error("Private storage returned no file stream.");
      try {
        await pipeline(response.Body as NodeJS.ReadableStream, createWriteStream(filePath, { flags: "wx", mode: 0o600 }));
        await chmod(filePath, 0o600);
        const info = await stat(filePath);
        if (!info.isFile()) throw new Error("Private storage returned an invalid file.");
        return await work(filePath);
      } catch (error) {
        if (error instanceof Error && error.message === missingMessage) throw error;
        throw new Error("Private storage could not prepare the file for processing.");
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  async importLocalFile(finalKey: string, sourcePath: string): Promise<number> {
    this.validate(finalKey);
    const { createReadStream } = await import("node:fs");
    const { size } = await stat(sourcePath).catch(() => { throw new Error("The generated file is unavailable."); });
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: finalKey, Body: createReadStream(sourcePath), ContentLength: size, IfNoneMatch: "*" }));
      return size;
    } catch (error) {
      if ([409, 412].includes(errorInfo(error).status ?? 0)) throw new Error("An object already exists under that key.");
      throw new Error("Private storage could not save the generated file.");
    }
  }

  async copyCommittedToStaging(sourceKey: string, stagingKey: string, assertLease?: () => void): Promise<number> {
    this.validate(sourceKey); this.validate(stagingKey); assertLease?.();
    let copied = false;
    try {
      await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: stagingKey, CopySource: copySource(this.bucket, sourceKey), IfNoneMatch: "*" }));
      copied = true;
      assertLease?.();
      const size = await this.statSize(stagingKey);
      assertLease?.();
      if (size === null) throw new Error("Private storage could not verify the copied file.");
      return size;
    } catch (error) {
      if (copied) await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: stagingKey })).catch(() => undefined);
      if (error instanceof InvalidStorageKeyError) throw error;
      if (error instanceof Error && error.message === "Media import lease was lost.") throw error;
      if ([409, 412].includes(errorInfo(error).status ?? 0)) throw new Error("An object already exists under that key.");
      throw error instanceof Error && error.message === "Media import lease was lost." ? error : new Error("Private storage could not copy the file.");
    }
  }
}
