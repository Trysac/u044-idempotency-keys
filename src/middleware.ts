import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { invalidOptions } from "./errors.js";
import { fingerprint, sha256Hex } from "./fingerprint.js";
import { parseIdempotencyKey } from "./key.js";
import * as limits from "./limits.js";
import type { IdempotencyStore, StoredResponse } from "./store.js";

/** A Node request, optionally carrying the raw body saved by a body parser. */
export type IdempotencyRequest = IncomingMessage & { rawBody?: Uint8Array };

/** Kinds of {@link IdempotencyEvent}. */
export type IdempotencyEventType =
  | "stored"
  | "replayed"
  | "conflict"
  | "in_progress"
  | "rejected"
  | "not_stored";

/** Observability event. Never contains the raw key or any body. */
export interface IdempotencyEvent {
  /** What happened. */
  readonly type: IdempotencyEventType;
  /** SHA-256 hex of the store key; empty when no valid key was available. */
  readonly keyHash: string;
  /** Error code for conflicts and rejections. */
  readonly code?: string;
}

/** Options of {@link createIdempotency}. */
export interface IdempotencyOptions {
  /** Storage backend. */
  readonly store: IdempotencyStore;
  /** Returns the tenant or user id; use "" only for global keys. */
  readonly scope: (req: IdempotencyRequest) => string;
  /** Header name. Defaults to `idempotency-key`. */
  readonly header?: string;
  /** Lifetime of stored responses in ms. Defaults to 86400000. */
  readonly ttlMs?: number;
  /** Lifetime of the in-flight lock in ms. Defaults to 60000. */
  readonly lockTtlMs?: number;
  /** Answer 400 KEY_REQUIRED when the header is missing. Defaults to false. */
  readonly required?: boolean;
  /** Methods that are made idempotent. Defaults to POST and PATCH. */
  readonly methods?: readonly string[];
  /** Response headers replayed to repeats. Defaults to content-type. */
  readonly replayHeaders?: readonly string[];
  /** Maximum request body size in bytes. Defaults to 1048576. */
  readonly maxBodyBytes?: number;
  /** Maximum stored response size in bytes. Defaults to 1048576. */
  readonly maxResponseBytes?: number;
  /** Decides whether a response status is stored. */
  readonly storeIf?: (status: number) => boolean;
  /** Accept unquoted Stripe-style keys. Defaults to true. */
  readonly acceptUnquoted?: boolean;
  /** Clock in ms used for `createdAt`. Defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Receives observability events; errors thrown by it are ignored. */
  readonly onEvent?: (event: IdempotencyEvent) => void;
}

/** Connect-style request handler returned by {@link createIdempotency}. */
export type IdempotencyMiddleware = (
  req: IdempotencyRequest,
  res: ServerResponse,
  next: () => unknown,
) => Promise<void>;

interface Config {
  readonly store: IdempotencyStore;
  readonly scope: (req: IdempotencyRequest) => string;
  readonly header: string;
  readonly ttlMs: number;
  readonly lockTtlMs: number;
  readonly required: boolean;
  readonly methods: ReadonlySet<string>;
  readonly replayHeaders: readonly string[];
  readonly maxBodyBytes: number;
  readonly maxResponseBytes: number;
  readonly storeIf: (status: number) => boolean;
  readonly acceptUnquoted: boolean;
  readonly clock: () => number;
  readonly onEvent: ((event: IdempotencyEvent) => void) | undefined;
}

interface Context {
  readonly storeKey: string;
  readonly owner: string;
  readonly keyHash: string;
  readonly fp: string;
}

interface CapturedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer | undefined;
}

type Opts = IdempotencyOptions;
type NumericKey = "ttlMs" | "lockTtlMs" | "maxBodyBytes" | "maxResponseBytes";
type Body = Uint8Array | undefined;
type Loose = (...args: unknown[]) => unknown;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const MAX_BODY = limits.DEFAULT_MAX_BODY_BYTES;
const MAX_RESPONSE = limits.DEFAULT_MAX_RESPONSE_BYTES;
const SEPARATOR = String.fromCharCode(0);
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const DIGITS = /^[0-9]{1,15}$/;
const NOT_STORED = new Set([408, 409, 425, 429]);

const PROBLEMS = {
  KEY_INVALID: { status: 400, title: "Bad Request" },
  KEY_REQUIRED: { status: 400, title: "Bad Request" },
  IN_PROGRESS: { status: 409, title: "Conflict" },
  BODY_TOO_LARGE: { status: 413, title: "Content Too Large" },
  KEY_REUSED: { status: 422, title: "Unprocessable Content" },
  STORE_FULL: { status: 503, title: "Service Unavailable" },
} as const;

type ProblemCode = keyof typeof PROBLEMS;

function defaultStoreIf(status: number): boolean {
  return status >= 200 && status <= 499 && !NOT_STORED.has(status);
}

function isStore(value: unknown): value is IdempotencyStore {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const names = ["get", "acquire", "save", "release"];
  return names.every((name) => typeof candidate[name] === "function");
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function intOpt(o: Opts, name: NumericKey, dflt: number): number {
  const value = o[name] ?? dflt;
  const min = name.startsWith("max") ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < min) {
    throw invalidOptions(`${name} must be an integer >= ${min}`);
  }
  return value;
}

function checkFn<T>(value: T, name: string): T {
  if (typeof value !== "function") {
    throw invalidOptions(`${name} must be a function`);
  }
  return value;
}

function resolveOptions(options: IdempotencyOptions): Config {
  if (typeof options !== "object" || options === null) {
    throw invalidOptions("options must be an object");
  }
  if (!isStore(options.store)) {
    throw invalidOptions("store must implement IdempotencyStore");
  }
  if (typeof options.scope !== "function") {
    throw invalidOptions("scope must be a function");
  }
  const header = options.header ?? "idempotency-key";
  if (typeof header !== "string" || !HEADER_TOKEN.test(header)) {
    throw invalidOptions("header must be a valid header field name");
  }
  const methods = options.methods ?? ["POST", "PATCH"];
  if (!isStringArray(methods) || methods.length === 0) {
    throw invalidOptions("methods must be a non-empty array of strings");
  }
  if (methods.some((method) => !HEADER_TOKEN.test(method))) {
    throw invalidOptions("methods must contain valid method tokens");
  }
  const names = options.replayHeaders ?? ["content-type"];
  if (!isStringArray(names)) {
    throw invalidOptions("replayHeaders must be an array of strings");
  }
  if (names.some((name) => !HEADER_TOKEN.test(name))) {
    throw invalidOptions("replayHeaders must contain valid header names");
  }
  const replay = new Set(names.map((name) => name.toLowerCase()));
  replay.delete("set-cookie");
  const ttlMs = intOpt(options, "ttlMs", DAY_MS);
  const lockTtlMs = intOpt(options, "lockTtlMs", MINUTE_MS);
  const maxBodyBytes = intOpt(options, "maxBodyBytes", MAX_BODY);
  const maxResponseBytes = intOpt(options, "maxResponseBytes", MAX_RESPONSE);
  const storeIf = checkFn(options.storeIf ?? defaultStoreIf, "storeIf");
  const clock = checkFn(options.clock ?? Date.now, "clock");
  if (options.onEvent !== undefined) {
    checkFn(options.onEvent, "onEvent");
  }
  return {
    store: options.store,
    scope: options.scope,
    header: header.toLowerCase(),
    ttlMs,
    lockTtlMs,
    required: options.required === true,
    methods: new Set(methods.map((method) => method.toUpperCase())),
    replayHeaders: [...replay],
    maxBodyBytes,
    maxResponseBytes,
    storeIf,
    acceptUnquoted: options.acceptUnquoted ?? true,
    clock,
    onEvent: options.onEvent,
  };
}

function emit(cfg: Config, event: IdempotencyEvent): void {
  if (cfg.onEvent === undefined) {
    return;
  }
  try {
    cfg.onEvent(event);
  } catch {
    // A failing listener must never break request handling.
  }
}

function sendProblem(res: ServerResponse, code: ProblemCode): void {
  const { status, title } = PROBLEMS[code];
  const body = JSON.stringify({ type: "about:blank", title, status, code });
  res.writeHead(status, {
    "Content-Type": "application/problem+json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function fail(
  cfg: Config,
  res: ServerResponse,
  type: IdempotencyEventType,
  code: ProblemCode,
  keyHash: string,
): void {
  emit(cfg, { type, keyHash, code });
  sendProblem(res, code);
}

function tryParse(raw: string, cfg: Config): string | undefined {
  try {
    return parseIdempotencyKey(raw, cfg.acceptUnquoted);
  } catch {
    return undefined;
  }
}

function readStream(req: IncomingMessage, max: number): Promise<Body> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onEnd = (): void => {
      resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > max) {
        chunks.length = 0;
        req.off("data", onData);
        req.off("end", onEnd);
        resolve(undefined);
        return;
      }
      chunks.push(buf);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", reject);
  });
}

async function readBody(req: IdempotencyRequest, max: number): Promise<Body> {
  const raw = req.rawBody;
  if (raw instanceof Uint8Array) {
    return raw.byteLength > max ? undefined : raw;
  }
  const declared = req.headers["content-length"];
  if (typeof declared === "string" && DIGITS.test(declared)) {
    if (Number(declared) > max) {
      return undefined;
    }
  }
  if (req.readableEnded) {
    throw invalidOptions("request body already consumed; set req.rawBody");
  }
  return readStream(req, max);
}

function normalizeHeader(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(String).join(", ");
  }
  return undefined;
}

function collectHeaders(input: object, out: Map<string, string>): void {
  const add = (name: unknown, value: unknown): void => {
    const text = normalizeHeader(value);
    if (typeof name === "string" && text !== undefined) {
      out.set(name.toLowerCase(), text);
    }
  };
  if (Array.isArray(input)) {
    if (input.every(Array.isArray)) {
      for (const pair of input) {
        add(pair[0], pair[1]);
      }
    } else {
      for (let i = 0; i + 1 < input.length; i += 2) {
        add(input[i], input[i + 1]);
      }
    }
    return;
  }
  for (const [name, value] of Object.entries(input)) {
    add(name, value);
  }
}

function pickEncoding(value: unknown): BufferEncoding {
  if (typeof value === "string" && Buffer.isEncoding(value)) {
    return value as BufferEncoding;
  }
  return "utf8";
}

function pickHeaders(
  res: ServerResponse,
  names: readonly string[],
  explicit: ReadonlyMap<string, string>,
): Readonly<Record<string, string>> {
  const picked = new Map<string, string>();
  for (const name of names) {
    const value = explicit.get(name) ?? normalizeHeader(res.getHeader(name));
    if (value !== undefined) {
      picked.set(name, value);
    }
  }
  return Object.fromEntries(picked);
}

function installCapture(
  res: ServerResponse,
  cfg: Config,
  onEnd: (captured: CapturedResponse) => Promise<void>,
): void {
  const origWriteHead = res.writeHead.bind(res) as unknown as Loose;
  const origWrite = res.write.bind(res) as unknown as Loose;
  const origEnd = res.end.bind(res) as unknown as Loose;
  const explicit = new Map<string, string>();
  const chunks: Buffer[] = [];
  let status: number | undefined;
  let size = 0;
  let overflow = false;
  let ended = false;

  const capture = (chunk: unknown, encoding: unknown): void => {
    if (overflow) {
      return;
    }
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
      return;
    }
    const enc = pickEncoding(encoding);
    const buf = typeof chunk === "string" ? Buffer.from(chunk, enc) : chunk;
    if (size + buf.byteLength > cfg.maxResponseBytes) {
      overflow = true;
      chunks.length = 0;
      return;
    }
    size += buf.byteLength;
    chunks.push(Buffer.from(buf));
  };

  res.writeHead = ((code: number, ...rest: unknown[]) => {
    status = code;
    for (const arg of rest) {
      if (typeof arg === "object" && arg !== null) {
        collectHeaders(arg, explicit);
      }
    }
    return origWriteHead(code, ...rest);
  }) as unknown as ServerResponse["writeHead"];

  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (!ended) {
      capture(chunk, rest[0]);
    }
    return origWrite(chunk, ...rest);
  }) as unknown as ServerResponse["write"];

  res.end = ((...args: unknown[]) => {
    if (ended) {
      return res;
    }
    ended = true;
    capture(args[0], args[1]);
    const snapshot: CapturedResponse = {
      status: status ?? res.statusCode,
      headers: pickHeaders(res, cfg.replayHeaders, explicit),
      body: overflow ? undefined : Buffer.concat(chunks),
    };
    onEnd(snapshot)
      .then(() => {
        origEnd(...args);
      })
      .catch(() => undefined);
    return res;
  }) as unknown as ServerResponse["end"];
}

function replay(res: ServerResponse, stored: StoredResponse, names: readonly string[]): void {
  const headers = new Map<string, string>();
  for (const name of names) {
    if (Object.hasOwn(stored.headers, name)) {
      headers.set(name, String(stored.headers[name]));
    }
  }
  headers.set("idempotent-replayed", "true");
  res.writeHead(stored.status, Object.fromEntries(headers));
  res.end(Buffer.from(stored.body, "base64"));
}

function respondStored(
  cfg: Config,
  res: ServerResponse,
  ctx: Context,
  stored: StoredResponse,
): void {
  if (stored.fingerprint !== ctx.fp) {
    fail(cfg, res, "conflict", "KEY_REUSED", ctx.keyHash);
    return;
  }
  emit(cfg, { type: "replayed", keyHash: ctx.keyHash });
  replay(res, stored, cfg.replayHeaders);
}

async function runHandler(
  cfg: Config,
  ctx: Context,
  res: ServerResponse,
  next: () => unknown,
): Promise<void> {
  let settled = false;
  const release = async (): Promise<void> => {
    try {
      await cfg.store.release(ctx.storeKey, ctx.owner);
    } catch {
      // Best effort: the lock expires on its own after lockTtlMs.
    }
  };
  const abandon = async (): Promise<void> => {
    if (settled) {
      return;
    }
    settled = true;
    await release();
    emit(cfg, { type: "not_stored", keyHash: ctx.keyHash });
  };
  const finish = async (captured: CapturedResponse): Promise<void> => {
    if (settled) {
      return;
    }
    settled = true;
    try {
      if (captured.body === undefined || !cfg.storeIf(captured.status)) {
        await release();
        emit(cfg, { type: "not_stored", keyHash: ctx.keyHash });
        return;
      }
      const value: StoredResponse = {
        status: captured.status,
        headers: captured.headers,
        body: captured.body.toString("base64"),
        fingerprint: ctx.fp,
        createdAt: cfg.clock(),
      };
      await cfg.store.save(ctx.storeKey, value, cfg.ttlMs, ctx.owner);
      emit(cfg, { type: "stored", keyHash: ctx.keyHash });
    } catch {
      await release();
      emit(cfg, { type: "not_stored", keyHash: ctx.keyHash });
    }
  };
  res.once("close", () => {
    void abandon();
  });
  installCapture(res, cfg, finish);
  try {
    await next();
  } catch (error) {
    await abandon();
    throw error;
  }
}

async function handle(
  cfg: Config,
  req: IdempotencyRequest,
  res: ServerResponse,
  next: () => unknown,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  if (!cfg.methods.has(method)) {
    await next();
    return;
  }
  const raw = req.headers[cfg.header];
  if (raw === undefined) {
    if (cfg.required) {
      fail(cfg, res, "rejected", "KEY_REQUIRED", "");
    } else {
      await next();
    }
    return;
  }
  const key = typeof raw === "string" ? tryParse(raw, cfg) : undefined;
  if (key === undefined) {
    fail(cfg, res, "rejected", "KEY_INVALID", "");
    return;
  }
  const scope = cfg.scope(req);
  if (typeof scope !== "string") {
    throw invalidOptions("scope must return a string");
  }
  const storeKey = `${scope}${SEPARATOR}${key}`;
  const keyHash = sha256Hex(storeKey);
  const body = await readBody(req, cfg.maxBodyBytes);
  if (body === undefined) {
    fail(cfg, res, "rejected", "BODY_TOO_LARGE", keyHash);
    return;
  }
  const fp = fingerprint(method, req.url ?? "", body, cfg.maxBodyBytes);
  const ctx: Context = { storeKey, keyHash, fp, owner: randomUUID() };
  const stored = await cfg.store.get(storeKey);
  if (stored !== undefined) {
    respondStored(cfg, res, ctx, stored);
    return;
  }
  const outcome = await cfg.store.acquire(storeKey, fp, cfg.lockTtlMs, ctx.owner);
  if (outcome === "full") {
    fail(cfg, res, "rejected", "STORE_FULL", keyHash);
    return;
  }
  if (outcome === "exists") {
    const done = await cfg.store.get(storeKey);
    if (done !== undefined) {
      respondStored(cfg, res, ctx, done);
      return;
    }
  }
  if (outcome !== "acquired") {
    fail(cfg, res, "in_progress", "IN_PROGRESS", keyHash);
    return;
  }
  await runHandler(cfg, ctx, res, next);
}

function buildMiddleware(cfg: Config): IdempotencyMiddleware {
  return (req, res, next) => handle(cfg, req, res, next);
}

/**
 * Creates an Idempotency-Key middleware for Node HTTP servers.
 *
 * Check order: method filter, header presence, key parsing, body size,
 * fingerprint, stored response (422 on a different fingerprint, replay on the
 * same one), lock acquisition (409 while in flight, 503 when the store is
 * full) and finally the handler. Request errors are answered as RFC 9457
 * problem responses; invalid configuration throws an `IdempotencyError`.
 *
 * Run a body parser whose verify hook stores `req.rawBody` before this
 * middleware; otherwise an unread request stream is read with a running byte
 * count and rejected with 413 beyond `maxBodyBytes`.
 *
 * @param options - Store, scope function and optional tuning.
 * @returns A `(req, res, next)` handler returning a promise.
 * @throws {IdempotencyError} With code `INVALID_OPTIONS` for bad options.
 */
export function createIdempotency(options: IdempotencyOptions) {
  return buildMiddleware(resolveOptions(options));
}
