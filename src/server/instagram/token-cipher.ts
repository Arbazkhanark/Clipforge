// AES-256-GCM for Instagram access tokens. The key stays in the server environment.
// Ciphertext is what gets stored. Callers must not log the token or the key.
// The v1 prefix is the only key version. Replacing INSTAGRAM_TOKEN_KEY does not decrypt old rows.
// There is no second key and no re-encrypt job. A lost or rotated key means the user reconnects.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function readInstagramTokenKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env["INSTAGRAM_TOKEN_KEY"]?.trim() ?? "";
  if (!raw || raw === "replace-me") return null;
  const key = Buffer.from(raw, "base64url");
  return key.length === 32 ? key : null;
}

export function encryptToken(key: Buffer, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const text = (value: Buffer) => Buffer.from(value).toString("base64url");
  return `v1.${text(iv)}.${text(tag)}.${text(encrypted)}`;
}

export function decryptToken(key: Buffer, stored: string): string | null {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const iv = Buffer.from(parts[1] ?? "", "base64url");
    const tag = Buffer.from(parts[2] ?? "", "base64url");
    const encrypted = Buffer.from(parts[3] ?? "", "base64url");
    if (iv.length !== 12 || tag.length !== 16 || encrypted.length === 0) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
