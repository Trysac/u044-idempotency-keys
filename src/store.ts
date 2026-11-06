import { invalidOptions } from "./errors.js";
import { DEFAULT_MAX_ENTRIES } from "./limits.js";

/** A completed response kept for replay. */
export interface StoredResponse {
  /** HTTP status code. */
  readonly status: number;
  /** Allowlisted response headers with lowercase names. */
  readonly headers: Readonly<Record<string, string>>;
  /** Response body, base64 encoded. */
  readonly body: string;
  /** Fingerprint of the request that produced the response. */
  readonly fingerprint: string;
  /** Creation time in milliseconds since the epoch. */
  readonly createdAt: number;
}

/** Result of {@link IdempotencyStore.acquire}. */
export type AcquireResult = "acquired" | "locked" | "exists" | "full";

/** Storage backend used by the middleware. */
export interface IdempotencyStore {
  /** Returns the completed response for `key`, if any (never a lock). */
  get(key: string): Promise<StoredResponse | undefined>;
  /**
   * Tries to take the in-flight lock for `key`.
   * Returns `exists` when a live completed entry exists, `locked` when a
   * live lock exists, `full` when no room can be made and `acquired` when
   * the caller now holds the lock for `ttl` milliseconds.
   */
  acquire(key: string, fp: string, ttl: number, owner?: string): Promise<AcquireResult>;
  /**
   * Stores a completed response; a no-op when a live completed entry exists
   * or when a live lock is held by a different `owner`.
   */
  save(key: string, value: StoredResponse, ttl: number, owner?: string): Promise<void>;
  /**
   * Removes the lock for `key`; completed entries are left untouched. When
   * `owner` is given only a lock held by that owner is removed.
   */
  release(key: string, owner?: string): Promise<void>;
}

/** Options of {@link MemoryStore}. */
export interface MemoryStoreOptions {
  /** Clock returning milliseconds. Defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Maximum number of entries (locks and completed). Defaults to 100000. */
  readonly maxEntries?: number;
}

interface LockEntry {
  readonly kind: "lock";
  readonly fingerprint: string;
  readonly owner: string | undefined;
  readonly expiresAt: number;
}

interface DoneEntry {
  readonly kind: "done";
  readonly value: StoredResponse;
  readonly expiresAt: number;
}

type Entry = LockEntry | DoneEntry;

function checkTtl(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidOptions(`${name} must be a positive integer`);
  }
}

function clone(value: StoredResponse): StoredResponse {
  return { ...value, headers: { ...value.headers } };
}

/**
 * Bounded in-memory {@link IdempotencyStore}.
 *
 * Locks and completed entries share one budget of `maxEntries`. When the cap
 * is reached expired items are purged first, then the oldest completed entry
 * is evicted; when only live locks remain `acquire` answers `full`.
 */
export class MemoryStore implements IdempotencyStore {
  readonly #entries = new Map<string, Entry>();
  readonly #clock: () => number;
  readonly #maxEntries: number;

  /**
   * @param options - Clock and entry cap.
   * @throws {IdempotencyError} With code `INVALID_OPTIONS` when `maxEntries`
   * is not a positive integer.
   */
  constructor(options: MemoryStoreOptions = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw invalidOptions("maxEntries must be a positive integer");
    }
    this.#maxEntries = maxEntries;
    this.#clock = options.clock ?? Date.now;
  }

  /** Number of stored items (locks and completed entries, expired or not). */
  get size(): number {
    return this.#entries.size;
  }

  async get(key: string): Promise<StoredResponse | undefined> {
    const entry = this.#live(key, this.#clock());
    return entry?.kind === "done" ? clone(entry.value) : undefined;
  }

  async acquire(key: string, fp: string, ttl: number, owner?: string): Promise<AcquireResult> {
    checkTtl("lockTtlMs", ttl);
    const now = this.#clock();
    const existing = this.#live(key, now);
    if (existing !== undefined) {
      return existing.kind === "done" ? "exists" : "locked";
    }
    if (!this.#makeRoom(now)) {
      return "full";
    }
    this.#entries.set(key, {
      kind: "lock",
      fingerprint: fp,
      owner,
      expiresAt: now + ttl,
    });
    return "acquired";
  }

  async save(key: string, value: StoredResponse, ttl: number, owner?: string): Promise<void> {
    checkTtl("ttlMs", ttl);
    const now = this.#clock();
    const existing = this.#live(key, now);
    if (existing?.kind === "done") {
      return;
    }
    if (existing?.kind === "lock" && owner !== undefined && existing.owner !== owner) {
      return;
    }
    if (existing !== undefined) {
      this.#entries.delete(key);
    } else if (!this.#makeRoom(now)) {
      return;
    }
    this.#entries.set(key, {
      kind: "done",
      value: clone(value),
      expiresAt: now + ttl,
    });
  }

  async release(key: string, owner?: string): Promise<void> {
    const entry = this.#entries.get(key);
    if (entry?.kind === "lock" && (owner === undefined || entry.owner === owner)) {
      this.#entries.delete(key);
    }
  }

  #live(key: string, now: number): Entry | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  #makeRoom(now: number): boolean {
    if (this.#entries.size < this.#maxEntries) {
      return true;
    }
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key);
      }
    }
    if (this.#entries.size < this.#maxEntries) {
      return true;
    }
    for (const [key, entry] of this.#entries) {
      if (entry.kind === "done") {
        this.#entries.delete(key);
        return true;
      }
    }
    return false;
  }
}
