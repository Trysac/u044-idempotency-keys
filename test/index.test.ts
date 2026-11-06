import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import * as lib from "../src/index.js";

const { IdempotencyError, MemoryStore, createIdempotency, fingerprint, parseIdempotencyKey } = lib;

type Ev = lib.IdempotencyEvent;
type Options = lib.IdempotencyOptions;
type Over = Partial<Options>;
type Req = lib.IdempotencyRequest;
type Store = lib.IdempotencyStore;
type Stored = lib.StoredResponse;
type Handler = (res: FakeRes) => unknown;
type Outcome = Awaited<ReturnType<Store["acquire"]>>;

const SEP = String.fromCharCode(0);
const KEY = { "idempotency-key": '"k1"' };
const BODY = '{"amount":10}';
const PROBLEM_422 =
  '{"type":"about:blank","title":"Unprocessable Content","status":422,"code":"KEY_REUSED"}';

function sha(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hashOf(scope: string, key: string): string {
  return sha(`${scope}${SEP}${key}`);
}

function toBuffer(chunk: string | Uint8Array, encoding?: unknown): Buffer {
  if (typeof chunk === "string") {
    const enc = typeof encoding === "string" ? encoding : "utf8";
    return Buffer.from(chunk, enc as BufferEncoding);
  }
  return Buffer.from(chunk);
}

class FakeRes extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  readonly chunks: Buffer[] = [];
  readonly headers = new Map<string, unknown>();
  readonly finished: Promise<void>;
  #resolve: () => void = () => undefined;

  constructor() {
    super();
    this.finished = new Promise<void>((resolve) => {
      this.#resolve = resolve;
    });
  }

  setHeader(name: string, value: unknown): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  getHeader(name: string): unknown {
    return this.headers.get(name.toLowerCase());
  }

  writeHead(status: number, ...rest: unknown[]): this {
    this.statusCode = status;
    this.headersSent = true;
    for (const arg of rest) {
      if (typeof arg === "object" && arg !== null && !Array.isArray(arg)) {
        for (const [name, value] of Object.entries(arg)) {
          this.setHeader(name, value);
        }
      }
    }
    return this;
  }

  write(chunk: string | Uint8Array, encoding?: unknown): boolean {
    this.chunks.push(toBuffer(chunk, encoding));
    return true;
  }

  end(chunk?: unknown, encoding?: unknown): this {
    if (typeof chunk === "string" || chunk instanceof Uint8Array) {
      this.chunks.push(toBuffer(chunk, encoding));
    }
    this.#resolve();
    return this;
  }

  get body(): Buffer {
    return Buffer.concat(this.chunks);
  }

  get bodyText(): string {
    return this.body.toString("utf8");
  }
}

function asRes(res: FakeRes): ServerResponse {
  return res as unknown as ServerResponse;
}

interface ReqInit {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[]>;
  body?: string | Uint8Array;
  rawBody?: Uint8Array;
  broken?: boolean;
}

function brokenStream(): Readable {
  return new Readable({
    read() {
      this.destroy(new Error("reset"));
    },
  });
}

function makeReq(init: ReqInit = {}): Req {
  const chunks = init.body === undefined ? [] : [toBuffer(init.body)];
  const stream = init.broken ? brokenStream() : Readable.from(chunks);
  const extra = init.rawBody === undefined ? {} : { rawBody: init.rawBody };
  return Object.assign(stream, {
    method: init.method ?? "POST",
    url: init.url ?? "/pay",
    headers: init.headers ?? {},
    ...extra,
  }) as unknown as Req;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(check()).toBe(true);
}

function codeOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
}

async function asyncCodeOf(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
}

function problem(res: FakeRes): Record<string, unknown> {
  return JSON.parse(res.bodyText) as Record<string, unknown>;
}

function respond201(res: FakeRes): void {
  res.setHeader("Content-Type", "application/json");
  res.statusCode = 201;
  res.end("ok");
}

interface Harness {
  readonly clock: { now: number };
  readonly events: Ev[];
  readonly store: lib.MemoryStore;
  readonly mw: lib.IdempotencyMiddleware;
  readonly calls: () => number;
  readonly send: (init: ReqInit, handler?: Handler) => Promise<FakeRes>;
}

function setup(over: Over = {}, maxEntries = 100_000): Harness {
  const clock = { now: 1_000 };
  const events: Ev[] = [];
  const store = new MemoryStore({ clock: () => clock.now, maxEntries });
  const mw = createIdempotency({
    store,
    scope: () => "u1",
    clock: () => clock.now,
    onEvent: (event) => events.push(event),
    ...over,
  });
  let calls = 0;
  const send = async (init: ReqInit, handler: Handler = respond201): Promise<FakeRes> => {
    const res = new FakeRes();
    const next = (): unknown => {
      calls += 1;
      return handler(res);
    };
    await mw(makeReq(init), asRes(res), next);
    await res.finished;
    return res;
  };
  return { clock, events, store, mw, calls: () => calls, send };
}

function stored(body = "b"): Stored {
  return {
    status: 200,
    headers: { "content-type": "text/plain" },
    body,
    fingerprint: "f",
    createdAt: 0,
  };
}

async function replayOf(handler: Handler, over: Over = {}): Promise<FakeRes> {
  const t = setup(over);
  await t.send({ headers: KEY, body: BODY }, handler);
  const second = await t.send({ headers: KEY, body: BODY }, handler);
  expect(t.calls()).toBe(1);
  return second;
}

describe("IdempotencyError", () => {
  it("carries a code and truncates long messages", () => {
    const error = new IdempotencyError("KEY_INVALID", "x".repeat(500));
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("IdempotencyError");
    expect(error.code).toBe("KEY_INVALID");
    expect(error.message).toHaveLength(200);
  });
});

const VALID: [string, string][] = [
  ['"abc"', "abc"],
  ['"a\\"b"', 'a"b'],
  ['"a\\\\b"', "a\\b"],
  ['  "abc"  ', "abc"],
  ["abc", "abc"],
  ["pay_1~x!", "pay_1~x!"],
];

const INVALID = [
  '""',
  `"${"a".repeat(256)}"`,
  '"a\\nb"',
  '"abc";p=1',
  '"a", "b"',
  '"\u00e9"',
  '"abc',
  '"abc\\"',
  '"a\\',
  '"',
  "",
  "   ",
  "a b",
  'a"b',
  "x".repeat(256),
  "y".repeat(2000),
  '"a\u0001b"',
];

describe("parseIdempotencyKey", () => {
  it.each(VALID)("decodes %s", (header, expected) => {
    expect(parseIdempotencyKey(header)).toBe(expected);
  });

  it.each(INVALID)("rejects %j", (header) => {
    expect(codeOf(() => parseIdempotencyKey(header))).toBe("KEY_INVALID");
  });

  it("rejects unquoted keys when they are not accepted", () => {
    expect(codeOf(() => parseIdempotencyKey("abc", false))).toBe("KEY_INVALID");
    expect(parseIdempotencyKey('"abc"', false)).toBe("abc");
  });

  it("rejects non-string input", () => {
    const code = codeOf(() => parseIdempotencyKey(5 as unknown as string));
    expect(code).toBe("KEY_INVALID");
  });

  it("accepts keys of exactly 255 characters", () => {
    const key = "k".repeat(255);
    expect(parseIdempotencyKey(key)).toBe(key);
    expect(parseIdempotencyKey(`"${key}"`)).toBe(key);
  });
});

describe("fingerprint", () => {
  it("hashes the method, target and body hash", () => {
    const body = Buffer.from(BODY);
    const expected = sha(`POST\n/pay?x=1\n${sha(body)}`);
    expect(fingerprint("post", "/pay?x=1", body)).toBe(expected);
  });

  it("hashes an empty body", () => {
    const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(sha("")).toBe(empty);
    const actual = fingerprint("POST", "/a", new Uint8Array());
    expect(actual).toBe(sha(`POST\n/a\n${empty}`));
  });

  it("changes with the method, path, query and body", () => {
    const body = new Uint8Array([1]);
    const base = fingerprint("POST", "/a", body);
    expect(fingerprint("PATCH", "/a", body)).not.toBe(base);
    expect(fingerprint("POST", "/b", body)).not.toBe(base);
    expect(fingerprint("POST", "/a?x=1", body)).not.toBe(base);
    expect(fingerprint("POST", "/a", new Uint8Array([2]))).not.toBe(base);
  });

  it("enforces the body size limit", () => {
    const big = new Uint8Array(1_048_577);
    expect(codeOf(() => fingerprint("POST", "/a", big))).toBe("BODY_TOO_LARGE");
    const four = new Uint8Array(4);
    expect(codeOf(() => fingerprint("POST", "/a", four, 3))).toBe("BODY_TOO_LARGE");
    expect(fingerprint("POST", "/a", four, 4)).toHaveLength(64);
  });
});

describe("MemoryStore", () => {
  function make(maxEntries = 2) {
    const clock = { now: 0 };
    const store = new MemoryStore({ clock: () => clock.now, maxEntries });
    return { clock, store };
  }

  it("purges an expired entry before evicting anything else", async () => {
    const { clock, store } = make();
    await store.acquire("a", "f", 1_000);
    await store.save("a", stored("a"), 1_000);
    await store.acquire("b", "f", 10);
    await store.save("b", stored("b"), 10);
    clock.now = 10;
    expect(await store.acquire("c", "f", 100)).toBe("acquired");
    expect(await store.get("a")).toBeDefined();
    expect(store.size).toBe(2);
  });

  it("evicts the oldest completed entry at the cap", async () => {
    const { store } = make();
    await store.acquire("a", "f", 1_000);
    await store.save("a", stored("a"), 1_000);
    await store.acquire("b", "f", 1_000);
    await store.save("b", stored("b"), 1_000);
    expect(await store.acquire("c", "f", 1_000)).toBe("acquired");
    expect(await store.get("a")).toBeUndefined();
    expect(await store.get("b")).toBeDefined();
  });

  it("keeps live locks while evicting a completed entry", async () => {
    const { store } = make();
    await store.acquire("a", "f", 1_000);
    await store.acquire("b", "f", 1_000);
    await store.save("b", stored("b"), 1_000);
    expect(await store.acquire("c", "f", 1_000)).toBe("acquired");
    expect(await store.get("b")).toBeUndefined();
    expect(await store.acquire("a", "f", 1_000)).toBe("locked");
  });

  it("answers full when only live locks remain", async () => {
    const { store } = make();
    expect(await store.acquire("a", "f", 1_000)).toBe("acquired");
    expect(await store.acquire("b", "f", 1_000)).toBe("acquired");
    expect(await store.acquire("c", "f", 1_000)).toBe("full");
    await store.save("c", stored("c"), 1_000);
    expect(await store.get("c")).toBeUndefined();
    await store.release("a");
    expect(await store.acquire("c", "f", 1_000)).toBe("acquired");
  });

  it("counts locks and entries with the default clock", async () => {
    const store = new MemoryStore({ maxEntries: 2 });
    expect(await store.acquire("a", "f", 60_000)).toBe("acquired");
    expect(await store.acquire("b", "f", 60_000)).toBe("acquired");
    expect(await store.acquire("c", "f", 60_000)).toBe("full");
    expect(store.size).toBe(2);
  });

  it("reports locked and exists and re-acquires after expiry", async () => {
    const { clock, store } = make();
    expect(await store.acquire("k", "f", 100)).toBe("acquired");
    expect(await store.acquire("k", "f", 100)).toBe("locked");
    clock.now = 100;
    expect(await store.acquire("k", "f", 100)).toBe("acquired");
    await store.save("k", stored("x"), 50);
    expect(await store.acquire("k", "f", 100)).toBe("exists");
  });

  it("never rewrites a live completed entry", async () => {
    const { store } = make();
    await store.acquire("k", "f", 100);
    await store.save("k", stored("first"), 100);
    await store.save("k", stored("second"), 100);
    expect((await store.get("k"))?.body).toBe("first");
  });

  it("replaces an expired completed entry and stores without a lock", async () => {
    const { clock, store } = make();
    await store.save("k", stored("old"), 10);
    clock.now = 10;
    await store.save("k", stored("new"), 10);
    expect((await store.get("k"))?.body).toBe("new");
  });

  it("releases only locks", async () => {
    const { store } = make();
    await store.acquire("k", "f", 100);
    await store.release("k");
    expect(store.size).toBe(0);
    await store.acquire("k", "f", 100);
    await store.save("k", stored("x"), 100);
    await store.release("k");
    await store.release("missing");
    expect(await store.get("k")).toBeDefined();
  });

  it("expires entries after their ttl", async () => {
    const { clock, store } = make();
    await store.save("k", stored(), 50);
    clock.now = 49;
    expect(await store.get("k")).toBeDefined();
    clock.now = 50;
    expect(await store.get("k")).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("returns copies of stored responses", async () => {
    const { store } = make();
    await store.save("k", stored(), 50);
    const first = await store.get("k");
    (first?.headers as Record<string, string>).x = "changed";
    expect((await store.get("k"))?.headers).toEqual({
      "content-type": "text/plain",
    });
  });

  it("validates its options and arguments", async () => {
    expect(codeOf(() => new MemoryStore({ maxEntries: 0 }))).toBe("INVALID_OPTIONS");
    expect(codeOf(() => new MemoryStore({ maxEntries: 1.5 }))).toBe("INVALID_OPTIONS");
    const { store } = make();
    const save = () => store.save("k", stored(), 0);
    expect(await asyncCodeOf(save)).toBe("INVALID_OPTIONS");
    const acquire = () => store.acquire("k", "f", Number.NaN);
    expect(await asyncCodeOf(acquire)).toBe("INVALID_OPTIONS");
  });

  it("works with default options", async () => {
    const store = new MemoryStore();
    expect(await store.acquire("k", "f", 1_000)).toBe("acquired");
    expect(store.size).toBe(1);
  });
});

describe("replay", () => {
  it("stores the first response and replays it byte for byte", async () => {
    const t = setup({ replayHeaders: ["content-type"] });
    const handler = (res: FakeRes): void => {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("X-Other", "1");
      res.statusCode = 201;
      res.end(Buffer.from([0, 255, 10]));
    };
    const first = await t.send({ headers: KEY, body: BODY }, handler);
    const second = await t.send({ headers: KEY, body: BODY }, handler);
    const bytes = new Uint8Array([0, 255, 10]);
    expect(t.calls()).toBe(1);
    expect(first.statusCode).toBe(201);
    expect(new Uint8Array(first.body)).toEqual(bytes);
    expect(second.statusCode).toBe(201);
    expect(second.getHeader("content-type")).toBe("application/octet-stream");
    expect(second.getHeader("x-other")).toBeUndefined();
    expect(second.getHeader("idempotent-replayed")).toBe("true");
    expect(new Uint8Array(second.body)).toEqual(bytes);
    expect(t.events.map((e) => e.type)).toEqual(["stored", "replayed"]);
  });

  const CHANGES: ReqInit[] = [
    { method: "PATCH" },
    { url: "/other" },
    { url: "/pay?x=1" },
    { body: '{"amount":11}' },
  ];

  it.each(CHANGES)("answers 422 when the key is reused with %j", async (change) => {
    const t = setup();
    await t.send({ headers: KEY, body: BODY });
    const res = await t.send({ headers: KEY, body: BODY, ...change });
    expect(res.statusCode).toBe(422);
    expect(res.getHeader("content-type")).toBe("application/problem+json");
    expect(res.bodyText).toBe(PROBLEM_422);
    expect(t.calls()).toBe(1);
    expect(t.events.at(-1)?.type).toBe("conflict");
  });

  it("fingerprints req.rawBody when it is present", async () => {
    const t = setup();
    const one = new Uint8Array([1, 2, 3]);
    const two = new Uint8Array([9, 9, 9]);
    await t.send({ headers: KEY, body: "zzz", rawBody: one });
    const same = await t.send({ headers: KEY, body: "zzz", rawBody: one });
    expect(same.getHeader("idempotent-replayed")).toBe("true");
    const other = await t.send({ headers: KEY, body: "zzz", rawBody: two });
    expect(other.statusCode).toBe(422);
  });

  it("answers 409 while the first request runs and recovers later", async () => {
    const t = setup({ lockTtlMs: 1_000 });
    let releaseA = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const init = { headers: KEY, body: BODY };
    const pendingA = t.send(init, (res) =>
      gate.then(() => {
        res.end("A");
      }),
    );
    await until(() => t.calls() === 1);
    const dup = await t.send(init);
    expect(dup.statusCode).toBe(409);
    expect(problem(dup).code).toBe("IN_PROGRESS");
    expect(problem(dup).title).toBe("Conflict");
    expect(t.calls()).toBe(1);
    t.clock.now += 1_000;
    const b = await t.send(init, (res) => {
      res.end("B");
    });
    expect(b.bodyText).toBe("B");
    expect(t.calls()).toBe(2);
    releaseA();
    const a = await pendingA;
    expect(a.bodyText).toBe("A");
    const again = await t.send(init);
    expect(again.bodyText).toBe("B");
    expect(t.calls()).toBe(2);
  });

  it("expires stored responses after ttlMs", async () => {
    const t = setup({ ttlMs: 5_000 });
    const init = { headers: KEY, body: BODY };
    await t.send(init);
    t.clock.now += 4_999;
    await t.send(init);
    expect(t.calls()).toBe(1);
    t.clock.now += 1;
    await t.send(init);
    expect(t.calls()).toBe(2);
  });

  it("replays only allowlisted headers from the store", async () => {
    const t = setup();
    const fp = fingerprint("POST", "/pay", Buffer.from(BODY));
    const entry: Stored = {
      status: 200,
      headers: {
        "set-cookie": "a=b",
        "content-type": "text/plain",
        "x-x": "1",
      },
      body: "eA==",
      fingerprint: fp,
      createdAt: 0,
    };
    await t.store.acquire(`u1${SEP}k1`, fp, 1_000);
    await t.store.save(`u1${SEP}k1`, entry, 1_000);
    const res = await t.send({ headers: KEY, body: BODY });
    expect(res.bodyText).toBe("x");
    expect(res.getHeader("content-type")).toBe("text/plain");
    expect(res.getHeader("set-cookie")).toBeUndefined();
    expect(res.getHeader("x-x")).toBeUndefined();
    expect(t.calls()).toBe(0);
  });
});

describe("keys through the middleware", () => {
  it("decodes sf-strings into the store key", async () => {
    const t = setup();
    await t.send({ headers: { "idempotency-key": '"a\\"b"' } });
    expect(await t.store.get(`u1${SEP}a"b`)).toBeDefined();
    await t.send({ headers: { "idempotency-key": '"abc"' } });
    expect(await t.store.get(`u1${SEP}abc`)).toBeDefined();
  });

  it("accepts unquoted keys by default", async () => {
    const t = setup();
    await t.send({ headers: { "idempotency-key": "abc" } });
    expect(await t.store.get(`u1${SEP}abc`)).toBeDefined();
  });

  it("rejects unquoted keys when acceptUnquoted is false", async () => {
    const t = setup({ acceptUnquoted: false });
    const res = await t.send({ headers: { "idempotency-key": "abc" } });
    expect(res.statusCode).toBe(400);
    expect(problem(res).code).toBe("KEY_INVALID");
  });

  it.each(INVALID)("answers 400 KEY_INVALID for %j", async (header) => {
    const t = setup();
    const res = await t.send({ headers: { "idempotency-key": header } });
    expect(res.statusCode).toBe(400);
    expect(res.getHeader("content-type")).toBe("application/problem+json");
    expect(problem(res)).toEqual({
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      code: "KEY_INVALID",
    });
    expect(t.calls()).toBe(0);
    expect(t.events).toEqual([{ type: "rejected", keyHash: "", code: "KEY_INVALID" }]);
  });

  it("rejects a repeated header", async () => {
    const t = setup();
    const headers = { "idempotency-key": ['"a"', '"b"'] };
    const res = await t.send({ headers });
    expect(res.statusCode).toBe(400);
    expect(problem(res).code).toBe("KEY_INVALID");
  });

  it("honors a custom header name", async () => {
    const t = setup({ header: "X-Request-Key" });
    await t.send({ headers: { "x-request-key": '"k1"' } });
    expect(await t.store.get(`u1${SEP}k1`)).toBeDefined();
  });
});

describe("pass-through", () => {
  it("passes requests without the header straight through", async () => {
    const t = setup();
    const res = await t.send({ body: BODY });
    expect(res.statusCode).toBe(201);
    expect(t.calls()).toBe(1);
    expect(t.store.size).toBe(0);
    expect(t.events).toEqual([]);
  });

  it("answers 400 KEY_REQUIRED when required is true", async () => {
    const t = setup({ required: true });
    const res = await t.send({ body: BODY });
    expect(res.statusCode).toBe(400);
    expect(problem(res).code).toBe("KEY_REQUIRED");
    expect(t.calls()).toBe(0);
    expect(t.events).toEqual([{ type: "rejected", keyHash: "", code: "KEY_REQUIRED" }]);
  });

  it.each(["GET", "HEAD"])("lets %s through untouched", async (method) => {
    const t = setup({ required: true });
    const res = await t.send({ method, headers: KEY });
    expect(res.statusCode).toBe(201);
    expect(t.calls()).toBe(1);
    expect(t.store.size).toBe(0);
  });

  it("honors custom methods", async () => {
    const t = setup({ methods: ["put"] });
    const init = { method: "PUT", headers: KEY, body: BODY };
    await t.send(init);
    await t.send(init);
    expect(t.calls()).toBe(1);
    await t.send({ headers: KEY, body: BODY });
    expect(t.calls()).toBe(2);
    expect(t.store.size).toBe(1);
  });

  it("uses a default method when the request has none", async () => {
    const t = setup();
    const req = makeReq({ headers: KEY });
    (req as { method?: string | undefined }).method = undefined;
    const res = new FakeRes();
    await t.mw(req, asRes(res), () => undefined);
    expect(t.store.size).toBe(0);
  });
});

describe("what is stored", () => {
  it.each([500, 408, 409, 425, 429])("does not store a %i", async (status) => {
    const t = setup();
    const handler = (res: FakeRes): void => {
      res.statusCode = status;
      res.end("no");
    };
    await t.send({ headers: KEY, body: BODY }, handler);
    await t.send({ headers: KEY, body: BODY }, handler);
    expect(t.calls()).toBe(2);
    const types = t.events.map((e) => e.type);
    expect(types).toEqual(["not_stored", "not_stored"]);
    expect(t.store.size).toBe(0);
  });

  it.each([200, 201, 404, 499])("stores a %i", async (status) => {
    const handler = (res: FakeRes): void => {
      res.statusCode = status;
      res.end("yes");
    };
    const second = await replayOf(handler);
    expect(second.statusCode).toBe(status);
  });

  it("releases the lock when the handler rejects", async () => {
    const t = setup();
    const init = { headers: KEY, body: BODY };
    const boom = () => Promise.reject(new Error("boom"));
    const run = t.mw(makeReq(init), asRes(new FakeRes()), boom);
    await expect(run).rejects.toThrow("boom");
    expect(t.events.map((e) => e.type)).toEqual(["not_stored"]);
    expect(t.store.size).toBe(0);
    await t.send(init);
    expect(t.calls()).toBe(1);
  });

  it("releases the lock when the handler throws synchronously", async () => {
    const t = setup();
    const init = { headers: KEY, body: BODY };
    const next = (): never => {
      throw new Error("sync boom");
    };
    const run = t.mw(makeReq(init), asRes(new FakeRes()), next);
    await expect(run).rejects.toThrow("sync boom");
    expect(t.store.size).toBe(0);
  });

  it("releases the lock when the connection closes early", async () => {
    const t = setup();
    const init = { headers: KEY, body: BODY };
    const res = new FakeRes();
    await t.mw(makeReq(init), asRes(res), () => undefined);
    res.emit("close");
    await until(() => t.events.length === 1);
    expect(t.events[0]?.type).toBe("not_stored");
    expect(t.store.size).toBe(0);
    res.end("late");
    await res.finished;
    expect(t.events).toHaveLength(1);
    await t.send(init);
    expect(t.calls()).toBe(1);
  });

  it("delivers but does not store a response above maxResponseBytes", async () => {
    const t = setup({ maxResponseBytes: 4 });
    const handler = (res: FakeRes): void => {
      res.write("abc");
      res.end("de");
    };
    const init = { headers: KEY, body: BODY };
    const first = await t.send(init, handler);
    expect(first.bodyText).toBe("abcde");
    await t.send(init, handler);
    expect(t.calls()).toBe(2);
    const types = t.events.map((e) => e.type);
    expect(types).toEqual(["not_stored", "not_stored"]);
  });

  it("stores a response of exactly maxResponseBytes", async () => {
    const handler = (res: FakeRes): void => {
      res.end("abcd");
    };
    const second = await replayOf(handler, { maxResponseBytes: 4 });
    expect(second.bodyText).toBe("abcd");
  });

  it("honors a custom storeIf", async () => {
    const t = setup({ storeIf: () => false });
    const init = { headers: KEY, body: BODY };
    await t.send(init);
    await t.send(init);
    expect(t.calls()).toBe(2);
  });

  it("treats a throwing storeIf as not stored", async () => {
    const storeIf = (): boolean => {
      throw new Error("policy");
    };
    const t = setup({ storeIf });
    const res = await t.send({ headers: KEY, body: BODY });
    expect(res.bodyText).toBe("ok");
    expect(t.events.at(-1)?.type).toBe("not_stored");
    expect(t.store.size).toBe(0);
  });

  it("still delivers the response when the store fails", async () => {
    const inner = new MemoryStore();
    const store: Store = {
      get: (key) => inner.get(key),
      acquire: (key, fp, ttl) => inner.acquire(key, fp, ttl),
      save: () => Promise.reject(new Error("disk full")),
      release: () => Promise.reject(new Error("unavailable")),
    };
    const t = setup({ store });
    const res = await t.send({ headers: KEY, body: BODY });
    expect(res.bodyText).toBe("ok");
    expect(t.events.at(-1)?.type).toBe("not_stored");
  });
});

describe("response capture", () => {
  it("captures headers passed to writeHead with a message", async () => {
    const second = await replayOf((res) => {
      res.writeHead(201, "Created", { "Content-Type": "text/plain" });
      res.end("x");
    });
    expect(second.statusCode).toBe(201);
    expect(second.getHeader("content-type")).toBe("text/plain");
  });

  it("captures a flat header array", async () => {
    const second = await replayOf((res) => {
      res.writeHead(202, ["Content-Type", "text/csv"]);
      res.end("x");
    });
    expect(second.statusCode).toBe(202);
    expect(second.getHeader("content-type")).toBe("text/csv");
  });

  it("captures header pairs", async () => {
    const second = await replayOf((res) => {
      res.writeHead(203, [["Content-Type", "text/html"]]);
      res.end("x");
    });
    expect(second.statusCode).toBe(203);
    expect(second.getHeader("content-type")).toBe("text/html");
  });

  it("concatenates writes and ignores end callbacks", async () => {
    const second = await replayOf((res) => {
      res.write(Buffer.from("ab"));
      res.write("cd", "utf8");
      res.end(() => undefined);
    });
    expect(second.bodyText).toBe("abcd");
  });

  it("honors the encoding passed to end", async () => {
    const second = await replayOf((res) => {
      res.end("\u00e9", "latin1");
    });
    expect(second.body.toString("latin1")).toBe("\u00e9");
  });

  it("normalizes numeric and array header values", async () => {
    const second = await replayOf(
      (res) => {
        res.setHeader("X-Count", 5);
        res.setHeader("X-Multi", ["a", "b"]);
        res.end("x");
      },
      { replayHeaders: ["x-count", "X-Multi", "x-count"] },
    );
    expect(second.getHeader("x-count")).toBe("5");
    expect(second.getHeader("x-multi")).toBe("a, b");
  });

  it("ignores a second end call", async () => {
    const second = await replayOf((res) => {
      res.end("a");
      res.end("b");
    });
    expect(second.bodyText).toBe("a");
  });

  it("replays an empty default response", async () => {
    const second = await replayOf((res) => {
      res.end();
    });
    expect(second.statusCode).toBe(200);
    expect(second.body).toHaveLength(0);
  });

  it("never replays set-cookie even when it is allowlisted", async () => {
    const t = setup({ replayHeaders: ["content-type", "Set-Cookie"] });
    const handler = (res: FakeRes): void => {
      res.setHeader("Content-Type", "text/plain");
      res.setHeader("Set-Cookie", "session=abc");
      res.end("x");
    };
    await t.send({ headers: KEY, body: BODY }, handler);
    const second = await t.send({ headers: KEY, body: BODY }, handler);
    expect(second.getHeader("set-cookie")).toBeUndefined();
    expect(second.getHeader("content-type")).toBe("text/plain");
    const entry = await t.store.get(`u1${SEP}k1`);
    expect(Object.keys(entry?.headers ?? {})).toEqual(["content-type"]);
  });
});

describe("scope", () => {
  it("keeps the same key independent across scope values", async () => {
    const scope = (req: Req): string => String(req.headers["x-user"]);
    const t = setup({ scope });
    const alice = { ...KEY, "x-user": "alice" };
    const bob = { ...KEY, "x-user": "bob" };
    await t.send({ headers: alice, body: BODY });
    const other = await t.send({ headers: bob, body: "different" });
    expect(other.statusCode).toBe(201);
    expect(t.calls()).toBe(2);
    const again = await t.send({ headers: alice, body: BODY });
    expect(again.getHeader("idempotent-replayed")).toBe("true");
    expect(t.calls()).toBe(2);
  });

  it("rejects a scope function that returns a non-string", async () => {
    const scope = (): string => 5 as unknown as string;
    const t = setup({ scope });
    const run = () => t.mw(makeReq({ headers: KEY }), asRes(new FakeRes()), () => 1);
    expect(await asyncCodeOf(run)).toBe("INVALID_OPTIONS");
  });
});

describe("limits", () => {
  it("answers 507-free 503 STORE_FULL when only live locks remain", async () => {
    const t = setup({}, 2);
    await t.store.acquire("x", "f", 60_000);
    await t.store.acquire("y", "f", 60_000);
    const res = await t.send({ headers: KEY, body: BODY });
    expect(res.statusCode).toBe(503);
    expect(problem(res)).toEqual({
      type: "about:blank",
      title: "Service Unavailable",
      status: 503,
      code: "STORE_FULL",
    });
    expect(t.calls()).toBe(0);
    expect(t.events).toEqual([
      {
        type: "rejected",
        keyHash: hashOf("u1", "k1"),
        code: "STORE_FULL",
      },
    ]);
  });

  it("answers 413 for a rawBody of maxBodyBytes + 1 bytes", async () => {
    const t = setup({ maxBodyBytes: 3 });
    const rawBody = new Uint8Array([1, 2, 3, 4]);
    const res = await t.send({ headers: KEY, rawBody });
    expect(res.statusCode).toBe(413);
    expect(problem(res)).toEqual({
      type: "about:blank",
      title: "Content Too Large",
      status: 413,
      code: "BODY_TOO_LARGE",
    });
    expect(t.calls()).toBe(0);
    expect(t.store.size).toBe(0);
  });

  it("accepts a rawBody of exactly maxBodyBytes", async () => {
    const t = setup({ maxBodyBytes: 3 });
    const res = await t.send({ headers: KEY, rawBody: new Uint8Array(3) });
    expect(res.statusCode).toBe(201);
  });

  it("counts streamed bytes against maxBodyBytes", async () => {
    const t = setup({ maxBodyBytes: 3 });
    const big = await t.send({ headers: KEY, body: "abcd" });
    expect(big.statusCode).toBe(413);
    expect(problem(big).code).toBe("BODY_TOO_LARGE");
    const ok = await t.send({ headers: KEY, body: "abc" });
    expect(ok.statusCode).toBe(201);
  });

  it("rejects a declared content-length above the limit", async () => {
    const t = setup({ maxBodyBytes: 3 });
    const headers = { ...KEY, "content-length": "4" };
    const res = await t.send({ headers });
    expect(res.statusCode).toBe(413);
    const odd = { ...KEY, "content-length": "abc" };
    const fine = await t.send({ headers: odd });
    expect(fine.statusCode).toBe(201);
  });

  it("fails loudly when the body was consumed without rawBody", async () => {
    const t = setup();
    const req = makeReq({ headers: KEY, body: BODY });
    req.resume();
    await new Promise((resolve) => req.once("end", resolve));
    const run = () => t.mw(req, asRes(new FakeRes()), () => undefined);
    expect(await asyncCodeOf(run)).toBe("INVALID_OPTIONS");
  });

  it("propagates stream errors", async () => {
    const t = setup();
    const req = makeReq({ headers: KEY, broken: true });
    const run = t.mw(req, asRes(new FakeRes()), () => undefined);
    await expect(run).rejects.toThrow("reset");
    expect(t.store.size).toBe(0);
  });
});

describe("stores that answer unusually", () => {
  const fp = fingerprint("POST", "/pay", Buffer.from(BODY));

  function scripted(outcome: Outcome, gets: (Stored | undefined)[]): Store {
    let index = 0;
    return {
      get: async () => {
        const value = gets[index];
        index += 1;
        return value;
      },
      acquire: async () => outcome,
      save: async () => undefined,
      release: async () => undefined,
    };
  }

  it("answers 409 when exists is reported but the entry vanished", async () => {
    const t = setup({ store: scripted("exists", [undefined, undefined]) });
    const res = await t.send({ headers: KEY, body: BODY });
    expect(res.statusCode).toBe(409);
    expect(problem(res).code).toBe("IN_PROGRESS");
  });

  it("replays the entry found after exists", async () => {
    const entry: Stored = { ...stored("eA=="), fingerprint: fp };
    const t = setup({ store: scripted("exists", [undefined, entry]) });
    const res = await t.send({ headers: KEY, body: BODY });
    expect(res.bodyText).toBe("x");
    expect(res.getHeader("idempotent-replayed")).toBe("true");
  });

  it("answers 409 when the key is locked", async () => {
    const t = setup({ store: scripted("locked", [undefined]) });
    const res = await t.send({ headers: KEY, body: BODY });
    expect(res.statusCode).toBe(409);
    expect(t.events.at(-1)?.type).toBe("in_progress");
  });
});

describe("privacy", () => {
  it("hashes the store key and never leaks the key or the body", async () => {
    const key = "secret-key-123";
    const body = "secret-body-456";
    const headers = { "idempotency-key": `"${key}"` };
    const t = setup();
    const first = await t.send({ headers, body });
    const repeat = await t.send({ headers, body });
    const reused = await t.send({ headers, body: "other-body" });
    const bad = await t.send({ headers: { "idempotency-key": `"${key}` } });
    expect(reused.statusCode).toBe(422);
    expect(first.statusCode).toBe(201);
    expect(repeat.getHeader("idempotent-replayed")).toBe("true");
    const hash = hashOf("u1", key);
    expect(t.events.map((e) => e.keyHash)).toEqual([hash, hash, hash, ""]);
    const seen = JSON.stringify(t.events) + reused.bodyText + bad.bodyText;
    expect(seen).not.toContain(key);
    expect(seen).not.toContain("secret-body-456");
    expect(seen).not.toContain("other-body");
  });

  it("ignores errors thrown by the event listener", async () => {
    const onEvent = (): void => {
      throw new Error("listener");
    };
    const t = setup({ onEvent });
    const res = await t.send({ headers: KEY, body: BODY });
    expect(res.statusCode).toBe(201);
  });
});

// Acceptance literals, quoted verbatim:
// header 'idempotent-replayed: true'
// the expired holder A finishes after B stored: A's save is ignored and replays return B's body
// '"' + 'a'.repeat(256) + '"', '"abc";p=1', '"a", "b"' and '"é"' return 400 with code 'KEY_INVALID'
describe("acceptance literals", () => {
  it("replays with idempotent-replayed: true and rejects invalid keys", async () => {
    const t = setup();
    await t.send({ headers: KEY, body: BODY });
    const again = await t.send({ headers: KEY, body: BODY });
    expect(`idempotent-replayed: ${String(again.getHeader("idempotent-replayed"))}`).toBe(
      "idempotent-replayed: true",
    );
    const long = '"' + "a".repeat(256) + '"';
    const headers = [long, '"abc";p=1', '"a", "b"', '"é"'];
    for (const header of headers) {
      const res = await t.send({ headers: { "idempotency-key": header } });
      expect(res.statusCode).toBe(400);
      expect(problem(res).code).toBe("KEY_INVALID");
    }
  });

  it("an expired holder A abandoning does not release B's lock", async () => {
    const t = setup({ lockTtlMs: 1_000 });
    const gate = (): { wait: Promise<void>; open: () => void } => {
      let open = (): void => undefined;
      const wait = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { wait, open };
    };
    const a = gate();
    const b = gate();
    const init = { headers: KEY, body: BODY };
    const pendingA = t.send(init, (res) =>
      a.wait.then(() => {
        res.statusCode = 500;
        res.end("A");
      }),
    );
    await until(() => t.calls() === 1);
    t.clock.now += 1_000;
    const pendingB = t.send(init, (res) =>
      b.wait.then(() => {
        res.end("B");
      }),
    );
    await until(() => t.calls() === 2);
    a.open();
    await pendingA;
    const dup = await t.send(init);
    expect(dup.statusCode).toBe(409);
    expect(t.calls()).toBe(2);
    b.open();
    await pendingB;
    const again = await t.send(init);
    expect(again.bodyText).toBe("B");
  });

  it("A's save is ignored and replays return B's body", async () => {
    const store = new MemoryStore({ clock: () => 0 });
    await store.acquire("k", "f", 100, "B");
    await store.save("k", stored("A"), 100, "A");
    await store.release("k", "A");
    expect(await store.acquire("k", "f", 100, "C")).toBe("locked");
    await store.save("k", stored("B"), 100, "B");
    await store.save("k", stored("A"), 100, "A");
    expect((await store.get("k"))?.body).toBe("B");
  });
});

describe("createIdempotency options", () => {
  const store = new MemoryStore();
  const scope = (): string => "u";
  const BAD: unknown[] = [
    null,
    { scope },
    { store: {}, scope },
    { store, scope: "u" },
    { store, scope, ttlMs: 0 },
    { store, scope, lockTtlMs: 1.5 },
    { store, scope, header: "" },
    { store, scope, header: "bad header" },
    { store, scope, maxBodyBytes: -1 },
    { store, scope, maxResponseBytes: Number.NaN },
    { store, scope, methods: [] },
    { store, scope, methods: [""] },
    { store, scope, methods: "POST" },
    { store, scope, replayHeaders: "content-type" },
    { store, scope, replayHeaders: [1] },
    { store, scope, replayHeaders: ["bad header"] },
    { store, scope, storeIf: "yes" },
    { store, scope, clock: 5 },
    { store, scope, onEvent: "log" },
  ];

  it.each(BAD)("rejects invalid options %#", (options) => {
    const code = codeOf(() => createIdempotency(options as Options));
    expect(code).toBe("INVALID_OPTIONS");
  });

  it("accepts a minimal valid configuration", () => {
    expect(typeof createIdempotency({ store, scope })).toBe("function");
  });
});
