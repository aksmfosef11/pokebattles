import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { GameError } from "@pokebattles/game";

/** 4–16 letters, digits or underscores (any script, so Korean IDs work). The ID is also the trainer name. */
const USERNAME = /^[\p{L}\p{N}_]{4,16}$/u;
export const PASSWORD_MIN = 4;
const PASSWORD_MAX = 72;

export function checkUsername(input: unknown): string {
  const name = typeof input === "string" ? input.normalize("NFC").trim() : "";
  if (!USERNAME.test(name)) throw new GameError("bad_username");
  return name;
}

export function checkPassword(input: unknown): string {
  if (typeof input !== "string" || input.length < PASSWORD_MIN || input.length > PASSWORD_MAX) throw new GameError("bad_password");
  return input;
}

const KEY_LEN = 32;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, KEY_LEN, (err, key) => (err ? reject(err) : resolve(key))));
}

/** `scrypt$<salt hex>$<key hex>` */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${(await derive(password, salt)).toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = await derive(password, Buffer.from(saltHex, "hex"));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Sessions are stored by hash, so a leaked database does not hand out logins. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newUserId(): string {
  return `u_${randomBytes(9).toString("base64url")}`;
}

/** At most `max` events per key within a sliding window (sign-ups per address). */
export class WindowLimit {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Records an event for `key`; false when that key is already at the limit (nothing is recorded). */
  take(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) {
      for (const [k, ts] of this.hits) if (ts.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
    return true;
  }
}

/** Loopback, private and link-local addresses: a proxy in front of us (nginx in docker-compose), not a player. */
export function isPrivateAddress(addr: string): boolean {
  const a = addr.toLowerCase().replace(/^::ffff:/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(a)) {
    const [p, q] = a.split(".").map(Number) as [number, number];
    return p === 10 || p === 127 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 169 && q === 254);
  }
  return a === "::1" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80:");
}

/** Wrong passwords per ID: after 10 within 10 minutes, that ID is refused until the window passes. */
export class LoginThrottle {
  private readonly fails = new Map<string, { n: number; since: number }>();

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 10 * 60 * 1000,
  ) {}

  check(username: string, now = Date.now()): void {
    const f = this.fails.get(username.toLowerCase());
    if (f && now - f.since < this.windowMs && f.n >= this.limit) throw new GameError("too_many_attempts");
  }

  fail(username: string, now = Date.now()): void {
    const key = username.toLowerCase();
    const f = this.fails.get(key);
    if (!f || now - f.since >= this.windowMs) this.fails.set(key, { n: 1, since: now });
    else f.n++;
    if (this.fails.size > 10_000) {
      for (const [k, v] of this.fails) if (now - v.since >= this.windowMs) this.fails.delete(k);
    }
  }

  clear(username: string): void {
    this.fails.delete(username.toLowerCase());
  }
}
