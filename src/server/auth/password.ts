// Password hashing with scrypt (built into Node, no packages). Format: scrypt$<log2 N>$<r>$<p>$<salt>$<hash> (base64url).
// The parameters live INSIDE the stored hash, so they can be raised later and old hashes upgraded at next login.
//
// NOT VERIFIED AGAINST LIVE DOCS (no network): the default cost (N = 2^17, r = 8, p = 1) is from memory of OWASP's
// guidance for scrypt. Argon2id is generally preferred but needs a package; switch when packages can be installed.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export interface ScryptParams { logN: number; r: number; p: number; }
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { logN: 17, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
/** Refuse absurd parameters from a (possibly tampered) stored hash: they would exhaust memory/CPU. */
const MAX_LOG_N = 18;

function derive(password: string, salt: Uint8Array, params: ScryptParams): Promise<Uint8Array> {
  const n = 2 ** params.logN;
  const maxmem = 256 * n * params.r + 1024 * 1024; // scrypt needs about 128 * N * r bytes
  return new Promise((resolve, reject) => scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { N: n, r: params.r, p: params.p, maxmem }, (error, key) => (error ? reject(error) : resolve(key))));
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, params);
  return ["scrypt", params.logN, params.r, params.p, Buffer.from(salt).toString("base64url"), Buffer.from(key).toString("base64url")].join("$");
}

function parseHash(stored: string): { params: ScryptParams; salt: Uint8Array; key: Uint8Array } | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [logN, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![logN, r, p].every(Number.isInteger) || logN < 10 || logN > MAX_LOG_N || r < 1 || r > 16 || p < 1 || p > 4) return null;
  const salt = Buffer.from(parts[4] as string, "base64url"), key = Buffer.from(parts[5] as string, "base64url");
  if (salt.length < 8 || key.length !== KEY_LENGTH) return null;
  return { params: { logN, r, p }, salt, key };
}

/** True only for the right password. Malformed or tampered hashes return false (never throw). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  try {
    const candidate = await derive(password, parsed.salt, parsed.params);
    return candidate.length === parsed.key.length && timingSafeEqual(candidate, parsed.key);
  } catch { return false; }
}

/** After a correct login: is the stored hash weaker than today's settings? Then store a fresh one. */
export function needsRehash(stored: string, current: ScryptParams): boolean {
  const parsed = parseHash(stored);
  return !parsed || parsed.params.logN < current.logN || parsed.params.r < current.r || parsed.params.p < current.p;
}

const COMMON_PASSWORDS = new Set(["password", "password1", "password123", "1234567890", "12345678910", "qwertyuiop", "letmein123", "iloveyou12", "admin12345", "welcome123", "abc1234567", "clipforge1"]);

/** Length and basic sanity only (NIST-style: no forced symbols). Returns a list of problems in plain words. */
export function checkPasswordPolicy(password: string, email: string): string[] {
  const problems: string[] = [];
  if (typeof password !== "string") return ["Password is required."];
  if (password.length < 10) problems.push("Password must be at least 10 characters.");
  if (password.length > 128) problems.push("Password must be at most 128 characters.");
  if (new Set(password).size < 4 && password.length > 0) problems.push("Password is too repetitive.");
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) problems.push("That password is too common.");
  const local = email.toLowerCase().split("@")[0] ?? "";
  if (lower === email.toLowerCase() || (local.length >= 4 && lower === local)) problems.push("Password must not be your email address.");
  return problems;
}

/** A hash to compare against when the account does not exist, so "no such user" costs about the same time as "wrong password". */
export async function makeDummyHash(params: ScryptParams): Promise<string> { return hashPassword(randomBytes(12).toString("base64url"), params); }
