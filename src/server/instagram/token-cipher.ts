// AES-256-GCM for Instagram access tokens. The key stays in the server environment.
// Ciphertext is what gets stored. Callers must not log the token or the key.
// The v1 prefix is the only key version. Replacing INSTAGRAM_TOKEN_KEY does not decrypt old rows.
// There is no second key and no re-encrypt job. A lost or rotated key means the user reconnects.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Environment } from "../environment.ts";

export function readInstagramTokenKey(env: Environment = process.env): Buffer | null {
  const raw = env["INSTAGRAM_TOKEN_KEY"]?.trim() ?? "";
  if (!raw || raw === "replace-me") return null;
  const key = Buffer.from(raw, "base64url");
  return key.length === 32 && key.toString("base64url") === raw ? key : null;
}

export function encryptToken(key: Buffer, token: string): string {
  if (key.length !== 32) throw new TypeError("Instagram token encryption key must be 32 bytes.");
  if (!token || token.length > 16_384) throw new TypeError("Instagram access token is invalid.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const text = (value: Buffer) => Buffer.from(value).toString("base64url");
  return `v1.${text(iv)}.${text(tag)}.${text(encrypted)}`;
}

export function decryptToken(key: Buffer, stored: string): string | null {
  if (key.length !== 32 || typeof stored !== "string" || stored.length > 32_768) return null;
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    if (parts.slice(1).some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
    const iv = Buffer.from(parts[1] ?? "", "base64url");
    const tag = Buffer.from(parts[2] ?? "", "base64url");
    const encrypted = Buffer.from(parts[3] ?? "", "base64url");
    if (iv.toString("base64url") !== parts[1] || tag.toString("base64url") !== parts[2] || encrypted.toString("base64url") !== parts[3]) return null;
    if (iv.length !== 12 || tag.length !== 16 || encrypted.length === 0) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const token = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    return token.length > 0 && token.length <= 16_384 ? token : null;
  } catch {
    return null;
  }
}
