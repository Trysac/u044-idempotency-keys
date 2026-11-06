# Usage

`@trysac/idempotency-keys` is an Idempotency-Key middleware for Node HTTP servers. It follows
`draft-ietf-httpapi-idempotency-key-header` (section 2.1 key syntax, section 2.4 fingerprint,
section 2.7 errors), RFC 9651 sf-strings and RFC 9457 problem details. It is framework-agnostic: the
returned function has the Connect signature `(req, res, next)`.

## Quick start

```ts
import { createServer } from "node:http";
import { MemoryStore, createIdempotency } from "@trysac/idempotency-keys";

const idempotency = createIdempotency({
  store: new MemoryStore(),
  scope: () => "tenant-1",
});

createServer((req, res) => {
  void idempotency(req, res, () => {
    res.end("created");
  });
}).listen(3000);
```

`scope` must return the tenant or user id of the caller, so one caller can never replay another caller's
response. Use `""` only for keys that are intentionally global.

## Request body

Run a body parser whose verify hook stores the raw bytes in `req.rawBody` before this middleware. Without
`rawBody` an unread request stream is read with a running byte count and rejected with 413 at
`maxBodyBytes + 1`. A stream that was already consumed without `rawBody` makes the middleware throw an
`IdempotencyError` with code `INVALID_OPTIONS`, because the body cannot be fingerprinted.

## Key syntax

The header value is an sf-string (`"k1"`). Inside it a backslash may only precede a double quote or a
backslash. Unquoted Stripe-style keys (`^[\x21\x23-\x7E]{1,255}$`) are accepted while `acceptUnquoted` is
true (the default). Decoded keys are 1-255 characters; anything else is answered with 400 `KEY_INVALID`.

## Check order

1. Method filter (default `POST` and `PATCH`).
2. Header presence (400 `KEY_REQUIRED` when `required` is true, otherwise pass through).
3. Key parsing (400 `KEY_INVALID`).
4. Body size (413 `BODY_TOO_LARGE`).
5. Fingerprint: SHA-256 of `METHOD\npathWithQuery\nsha256hex(body)`.
6. Stored response: a different fingerprint gives 422 `KEY_REUSED`, the same fingerprint is replayed.
7. Lock: 409 `IN_PROGRESS` while another request holds the key, 503 `STORE_FULL` when the store holds only
   live locks.
8. The handler runs; its response is captured and stored.

Problem responses use `Content-Type: application/problem+json` and the body
`{"type":"about:blank","title":"...","status":...,"code":"..."}`. They never contain the key or the body.

## What is stored

The status, the allowlisted headers (`replayHeaders`, lowercased, never `set-cookie`) and the body bytes.
Responses with a status outside 200-499 or equal to 408, 409, 425 or 429 are not stored, nor are responses
larger than `maxResponseBytes`; in those cases, and when the handler throws or the connection closes first,
the lock is released so a retry runs the handler again. The client always receives the complete response.
The response is delivered after it was saved, so a fast retry never sees a half-finished entry.

Replays add `Idempotent-Replayed: true`. This header is a non-standard extension of this library.

## Events

`onEvent` receives `{ type, keyHash, code? }` with `type` one of `stored`, `replayed`, `conflict`,
`in_progress`, `rejected` and `not_stored`. `keyHash` is the SHA-256 hex of the store key (scope, a NUL
character and the key); it is empty when no valid key was available. Errors thrown by the listener are
ignored.

## Stores

`MemoryStore` is bounded by `maxEntries` (default 100000) shared by locks and completed entries. At the cap
expired items are purged first, then the oldest completed entry is evicted, and with only live locks
`acquire` answers `full`. Implement `IdempotencyStore` to use another backend; Redis and SQL stores are out of
scope for this package.

## Limitations

- The store interface has no owner token. If a lock expires while its holder is still running, the holder's
  later `release` can remove the lock of a newer holder, and a completed entry is never rewritten: the first
  response saved wins.
- `MemoryStore` is per process; use a shared store when running several instances.
- `fingerprint` hashes the request target as received; the middleware bounds the body through
  `maxBodyBytes` and relies on Node's header size limit for the URL.
