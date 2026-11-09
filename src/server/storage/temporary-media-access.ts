import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canKeepUsingSourceForCycleItem } from "../../lib/domain/sharing-permissions.ts";
import type { CycleItem } from "../../lib/domain/types.ts";
import type { Repository } from "../repository.ts";
import type { MediaStorage } from "./media-storage.ts";

const authorizedOutputs = new WeakSet<object>();
const authorizedCovers = new WeakSet<object>();

/** A server-minted capability for one stored render output and its exact cycle item. */
export interface AuthorizedRenderedPublishingOutput {
  readonly outputId: string;
  readonly ownerId: string;
  readonly cycleId: string;
  readonly cycleItemId: string;
  readonly sourceMediaId: string;
  readonly sizeBytes: number;
  readonly mimeType: "video/mp4";
}

/** A server-minted capability for an owned JPEG cover selected on one exact cycle item. */
export interface AuthorizedPublishingCover {
  readonly mediaId: string;
  readonly ownerId: string;
  readonly cycleId: string;
  readonly cycleItemId: string;
  readonly sizeBytes: number;
  readonly mimeType: "image/jpeg";
}

export type PublishingMediaAccessStatus =
  | "media_not_available"
  | "media_not_eligible"
  | "temporary_access_not_configured"
  | "temporary_access_expired"
  | "temporary_media_access_ready";

export type AuthorizeRenderedOutputResult =
  | { status: "authorized"; output: AuthorizedRenderedPublishingOutput }
  | { status: "media_not_available" | "media_not_eligible" };

export interface TemporaryMediaAccessResult {
  url: string;
  expiresAt: Date;
  /** Mock adapters always set false. Only a real provider may attest to Meta reachability. */
  publiclyReachable: boolean;
}

export interface TemporaryMediaAccessAdapter {
  readonly mode: "mock" | "provider";
  createTemporaryAccess(output: AuthorizedRenderedPublishingOutput, now: Date, ttlSeconds: number): Promise<TemporaryMediaAccessResult>;
  validateTemporaryAccess(url: string, output: AuthorizedRenderedPublishingOutput, now: Date): Promise<boolean>;
  createTemporaryCoverAccess(cover: AuthorizedPublishingCover, now: Date, ttlSeconds: number): Promise<TemporaryMediaAccessResult>;
  validateTemporaryCoverAccess(url: string, cover: AuthorizedPublishingCover, now: Date): Promise<boolean>;
}

export type PreparedTemporaryMediaAccess =
  | { status: "media_not_available" | "media_not_eligible" | "temporary_access_not_configured" | "temporary_access_expired" }
  | ({ status: "temporary_media_access_ready" } & TemporaryMediaAccessResult);

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const isMinted = (output: AuthorizedRenderedPublishingOutput): boolean => typeof output === "object" && output !== null && authorizedOutputs.has(output);
const isMintedCover = (cover: AuthorizedPublishingCover): boolean => typeof cover === "object" && cover !== null && authorizedCovers.has(cover);

/**
 * Authorizes only an existing render derivative that belongs to the caller and was rendered from
 * the exact source selected by an owned, running, due cycle item. Original MediaAsset ids cannot
 * pass this check. Storage keys and paths stay inside this server function.
 */
export async function authorizeRenderedPublishingOutput(
  repo: Repository,
  storage: MediaStorage | null,
  input: { ownerId: string; cycleId: string; cycleItemId: string; now: Date },
): Promise<AuthorizeRenderedOutputResult> {
  const cycle = await repo.getCycle(input.cycleId);
  if (!cycle || cycle.ownerId !== input.ownerId || cycle.status !== "running") return { status: "media_not_eligible" };
  const items = await repo.getCycleItems(cycle.id);
  const item = items.find((candidate) => candidate.id === input.cycleItemId);
  if (!item || item.cycleOwnerId !== input.ownerId || item.cycleId !== cycle.id || (item.status !== "scheduled" && item.status !== "publishing") || !item.scheduledFor || item.scheduledFor > input.now) return { status: "media_not_eligible" };
  if (!item.selectedRenderOutputId) return { status: "media_not_eligible" };

  const media = await repo.getMedia(item.mediaAssetId);
  if (!media) return { status: "media_not_available" };
  if (media.kind !== "video") return { status: "media_not_eligible" };
  const collection = item.sourceCollectionId ? await repo.getCollection(item.sourceCollectionId) : null;
  const grants = collection ? await repo.getGrants(collection.id) : [];
  if (!canKeepUsingSourceForCycleItem(item, media, collection, grants, input.now).allowed) return { status: "media_not_eligible" };

  const output = await repo.getRenderOutput(item.selectedRenderOutputId);
  if (!output || output.ownerId !== input.ownerId || output.sourceMediaId !== item.mediaAssetId) return { status: "media_not_eligible" };
  if (!storage) return { status: "media_not_available" };
  const metadata = await storage.getPrivateMetadata(output.storageKey);
  if (!metadata || metadata.sizeBytes <= 0 || metadata.sizeBytes !== output.sizeBytes) return { status: "media_not_available" };

  const authorized: AuthorizedRenderedPublishingOutput = Object.freeze({
    outputId: output.id,
    ownerId: input.ownerId,
    cycleId: cycle.id,
    cycleItemId: item.id,
    sourceMediaId: item.mediaAssetId,
    sizeBytes: output.sizeBytes,
    mimeType: "video/mp4",
  });
  authorizedOutputs.add(authorized);
  return { status: "authorized", output: authorized };
}

/** Offline adapter for tests. Its `.invalid` URL can never be publicly resolved or fetched by Meta. */
export class MockTemporaryMediaAccessAdapter implements TemporaryMediaAccessAdapter {
  readonly mode = "mock" as const;
  private readonly grants = new Map<string, { outputId: string; expiresAt: Date }>();

  async createTemporaryAccess(output: AuthorizedRenderedPublishingOutput, now: Date, ttlSeconds: number): Promise<TemporaryMediaAccessResult> {
    if (!isMinted(output)) throw new Error("Rendered publishing media is not authorized.");
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) throw new RangeError("Temporary access lifetime is invalid.");
    for (const [url, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(url);
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const expires = String(Math.floor(expiresAt.getTime() / 1000));
    const signature = digest(`${output.outputId}:${expires}`);
    const url = `https://media-access.mock.invalid/v1/${digest(output.outputId)}?expires=${expires}&signature=${signature}`;
    this.grants.set(url, { outputId: output.outputId, expiresAt });
    return { url, expiresAt, publiclyReachable: false };
  }

  async validateTemporaryAccess(url: string, output: AuthorizedRenderedPublishingOutput, now: Date): Promise<boolean> {
    if (!isMinted(output)) return false;
    const grant = this.grants.get(url);
    if (!grant) return false;
    if (grant.expiresAt <= now) { this.grants.delete(url); return false; }
    return grant.outputId === output.outputId;
  }
  async createTemporaryCoverAccess(cover: AuthorizedPublishingCover, now: Date, ttlSeconds: number): Promise<TemporaryMediaAccessResult> {
    if (!isMintedCover(cover)) throw new Error("Publishing cover is not authorized.");
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) throw new RangeError("Temporary access lifetime is invalid.");
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const url = `https://media-access.mock.invalid/covers/${digest(`${cover.mediaId}:${Math.floor(expiresAt.getTime() / 1000)}`)}`;
    this.grants.set(url, { outputId: cover.mediaId, expiresAt });
    return { url, expiresAt, publiclyReachable: false };
  }
  async validateTemporaryCoverAccess(url: string, cover: AuthorizedPublishingCover, now: Date): Promise<boolean> {
    if (!isMintedCover(cover)) return false;
    const grant = this.grants.get(url);
    if (!grant || grant.expiresAt <= now) return false;
    return grant.outputId === cover.mediaId;
  }
}

interface SignedMediaGrant { kind: "render"; outputId: string; ownerId: string; cycleId: string; cycleItemId: string; sourceMediaId: string; expiresAt: number; }
interface SignedCoverGrant { kind: "cover"; mediaId: string; ownerId: string; cycleId: string; cycleItemId: string; expiresAt: number; }

/** App-hosted, object-scoped signed media capability. It is configured only with a public HTTPS origin and a distinct signing key. */
export class HmacTemporaryMediaAccessAdapter implements TemporaryMediaAccessAdapter {
  readonly mode = "provider" as const;
  private readonly baseUrl: URL;
  constructor(baseUrl: string, private readonly signingKey: Buffer) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname.endsWith(".invalid")) throw new TypeError("Public media origin must be a clean HTTPS origin.");
    if (signingKey.length !== 32) throw new TypeError("Temporary media signing key must be 32 bytes.");
    this.baseUrl = parsed;
  }
  async createTemporaryAccess(output: AuthorizedRenderedPublishingOutput, now: Date, ttlSeconds: number): Promise<TemporaryMediaAccessResult> {
    if (!isMinted(output)) throw new Error("Rendered publishing media is not authorized.");
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) throw new RangeError("Temporary access lifetime is invalid.");
    const grant: SignedMediaGrant = { kind: "render", outputId: output.outputId, ownerId: output.ownerId, cycleId: output.cycleId, cycleItemId: output.cycleItemId, sourceMediaId: output.sourceMediaId, expiresAt: Math.floor((now.getTime() + ttlSeconds * 1000) / 1000) };
    const token = Buffer.from(JSON.stringify(grant)).toString("base64url");
    const signature = createHmac("sha256", this.signingKey).update(token).digest("base64url");
    const url = new URL(`/api/publishing-media/${token}.${signature}`, this.baseUrl).toString();
    return { url, expiresAt: new Date(grant.expiresAt * 1000), publiclyReachable: true };
  }
  async validateTemporaryAccess(url: string, output: AuthorizedRenderedPublishingOutput, now: Date): Promise<boolean> {
    if (!isMinted(output)) return false;
    const grant = this.readGrant(url, now);
    return !!grant && grant.outputId === output.outputId && grant.ownerId === output.ownerId && grant.cycleId === output.cycleId && grant.cycleItemId === output.cycleItemId && grant.sourceMediaId === output.sourceMediaId;
  }
  async createTemporaryCoverAccess(cover: AuthorizedPublishingCover, now: Date, ttlSeconds: number): Promise<TemporaryMediaAccessResult> {
    if (!isMintedCover(cover)) throw new Error("Publishing cover is not authorized.");
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) throw new RangeError("Temporary access lifetime is invalid.");
    const grant: SignedCoverGrant = { kind: "cover", mediaId: cover.mediaId, ownerId: cover.ownerId, cycleId: cover.cycleId, cycleItemId: cover.cycleItemId, expiresAt: Math.floor((now.getTime() + ttlSeconds * 1000) / 1000) };
    const token = Buffer.from(JSON.stringify(grant)).toString("base64url");
    const signature = createHmac("sha256", this.signingKey).update(token).digest("base64url");
    return { url: new URL(`/api/publishing-covers/${token}.${signature}`, this.baseUrl).toString(), expiresAt: new Date(grant.expiresAt * 1000), publiclyReachable: true };
  }
  async validateTemporaryCoverAccess(url: string, cover: AuthorizedPublishingCover, now: Date): Promise<boolean> {
    if (!isMintedCover(cover)) return false;
    const grant = this.readCoverGrant(url, now);
    return !!grant && grant.mediaId === cover.mediaId && grant.ownerId === cover.ownerId && grant.cycleId === cover.cycleId && grant.cycleItemId === cover.cycleItemId;
  }
  readGrant(url: string, now: Date): SignedMediaGrant | null {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== this.baseUrl.origin || parsed.search || parsed.hash) return null;
      const match = /^\/api\/publishing-media\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(parsed.pathname);
      if (!match) return null;
      const token = match[1]!; const supplied = Buffer.from(match[2]!, "base64url"); const expected = Buffer.from(createHmac("sha256", this.signingKey).update(Buffer.from(token, "utf8")).digest("hex"), "hex");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
      const value: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
      if (!value || typeof value !== "object") return null;
      const grant = value as Partial<SignedMediaGrant>;
      if (grant.kind !== "render" || ![grant.outputId, grant.ownerId, grant.cycleId, grant.cycleItemId, grant.sourceMediaId].every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id!)) || !Number.isSafeInteger(grant.expiresAt) || (grant.expiresAt as number) <= Math.floor(now.getTime() / 1000)) return null;
      return grant as SignedMediaGrant;
    } catch { return null; }
  }
  readCoverGrant(url: string, now: Date): SignedCoverGrant | null {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== this.baseUrl.origin || parsed.search || parsed.hash) return null;
      const match = /^\/api\/publishing-covers\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(parsed.pathname);
      if (!match) return null;
      const token = match[1]!; const supplied = Buffer.from(match[2]!, "base64url"); const expected = Buffer.from(createHmac("sha256", this.signingKey).update(Buffer.from(token, "utf8")).digest("hex"), "hex");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
      const value: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
      if (!value || typeof value !== "object") return null;
      const grant = value as Partial<SignedCoverGrant>;
      if (grant.kind !== "cover" || ![grant.mediaId, grant.ownerId, grant.cycleId, grant.cycleItemId].every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id!)) || !Number.isSafeInteger(grant.expiresAt) || (grant.expiresAt as number) <= Math.floor(now.getTime() / 1000)) return null;
      return grant as SignedCoverGrant;
    } catch { return null; }
  }
}

export function createConfiguredTemporaryMediaAccessAdapter(env: NodeJS.ProcessEnv = process.env): HmacTemporaryMediaAccessAdapter | null {
  const origin = env["CLIPFORGE_PUBLIC_MEDIA_ORIGIN"]?.trim() ?? "";
  const rawKey = env["CLIPFORGE_TEMP_MEDIA_SIGNING_KEY"]?.trim() ?? "";
  if (!origin || !rawKey) return null;
  const key = Buffer.from(rawKey, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== rawKey) return null;
  try { return new HmacTemporaryMediaAccessAdapter(origin, key); } catch { return null; }
}

/** Creates a short-lived URL only after authorization; never returns it in preflight/UI data. */
export async function prepareTemporaryPublishingAccess(
  repo: Repository,
  storage: MediaStorage | null,
  adapter: TemporaryMediaAccessAdapter | null,
  input: { ownerId: string; cycleId: string; cycleItemId: string; now: Date; ttlSeconds?: number },
): Promise<PreparedTemporaryMediaAccess> {
  const authorization = await authorizeRenderedPublishingOutput(repo, storage, input);
  if (authorization.status !== "authorized") return authorization;
  if (!adapter) return { status: "temporary_access_not_configured" };
  try {
    const result = await adapter.createTemporaryAccess(authorization.output, input.now, input.ttlSeconds ?? 300);
    if (!(result.expiresAt instanceof Date) || result.expiresAt <= input.now || !(await adapter.validateTemporaryAccess(result.url, authorization.output, input.now))) return { status: "temporary_access_expired" };
    return { status: "temporary_media_access_ready", ...result };
  } catch {
    return { status: "temporary_access_not_configured" };
  }
}

export type PreparedTemporaryPublishingCover =
  | { status: "cover_not_selected" }
  | { status: "media_not_available" | "media_not_eligible" | "temporary_access_not_configured" | "temporary_access_expired" }
  | ({ status: "temporary_cover_access_ready" } & TemporaryMediaAccessResult);

export async function authorizePublishingCover(repo: Repository, storage: MediaStorage | null, input: { ownerId: string; cycleId: string; cycleItemId: string; now: Date }): Promise<{ status: "authorized"; cover: AuthorizedPublishingCover } | { status: "cover_not_selected" | "media_not_available" | "media_not_eligible" }> {
  const cycle = await repo.getCycle(input.cycleId);
  if (!cycle || cycle.ownerId !== input.ownerId || cycle.status !== "running") return { status: "media_not_eligible" };
  const item = (await repo.getCycleItems(cycle.id)).find((candidate) => candidate.id === input.cycleItemId);
  if (!item || item.cycleOwnerId !== input.ownerId || item.cycleId !== cycle.id || (item.status !== "scheduled" && item.status !== "publishing") || !item.scheduledFor || item.scheduledFor > input.now) return { status: "media_not_eligible" };
  if (!item.coverMediaId) return { status: "cover_not_selected" };
  const media = await repo.getMedia(item.coverMediaId);
  if (!media || media.ownerId !== input.ownerId || media.status !== "active") return { status: "media_not_eligible" };
  if (media.kind !== "image" || media.mimeType !== "image/jpeg") return { status: "media_not_eligible" };
  // Meta specifies 8 MB without defining the byte multiple; use decimal MB conservatively.
  if (!Number.isSafeInteger(media.sizeBytes) || media.sizeBytes <= 0 || media.sizeBytes > 8_000_000) return { status: "media_not_eligible" };
  if (!storage) return { status: "media_not_available" };
  const stored = await repo.getMediaStorageInfo(media.id);
  if (!stored || stored.mimeType !== "image/jpeg") return { status: "media_not_available" };
  const metadata = await storage.getPrivateMetadata(stored.storageKey).catch(() => null);
  if (!metadata || metadata.sizeBytes !== media.sizeBytes || metadata.sizeBytes > 8_000_000) return { status: "media_not_available" };
  const cover: AuthorizedPublishingCover = Object.freeze({ mediaId: media.id, ownerId: input.ownerId, cycleId: cycle.id, cycleItemId: item.id, sizeBytes: metadata.sizeBytes, mimeType: "image/jpeg" });
  authorizedCovers.add(cover);
  return { status: "authorized", cover };
}

export async function prepareTemporaryPublishingCoverAccess(repo: Repository, storage: MediaStorage | null, adapter: TemporaryMediaAccessAdapter | null, input: { ownerId: string; cycleId: string; cycleItemId: string; now: Date; ttlSeconds?: number }): Promise<PreparedTemporaryPublishingCover> {
  const authorization = await authorizePublishingCover(repo, storage, input);
  if (authorization.status !== "authorized") return authorization;
  if (!adapter) return { status: "temporary_access_not_configured" };
  try {
    const result = await adapter.createTemporaryCoverAccess(authorization.cover, input.now, input.ttlSeconds ?? 300);
    if (!(result.expiresAt instanceof Date) || result.expiresAt <= input.now || !(await adapter.validateTemporaryCoverAccess(result.url, authorization.cover, input.now))) return { status: "temporary_access_expired" };
    return { status: "temporary_cover_access_ready", ...result };
  } catch { return { status: "temporary_access_not_configured" }; }
}

/** Used by tests and trusted server code to keep provider-specific reachability out of URL parsing. */
export function isAuthorizedRenderedPublishingOutput(output: AuthorizedRenderedPublishingOutput): boolean {
  return isMinted(output);
}
