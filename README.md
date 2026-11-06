# idempotency-keys

[![npm version](https://img.shields.io/npm/v/@trysac/idempotency-keys.svg)](https://www.npmjs.com/package/@trysac/idempotency-keys)
[![license: MIT](https://img.shields.io/npm/l/@trysac/idempotency-keys.svg)](LICENSE)
[![CI](https://github.com/Trysac/u044-idempotency-keys/actions/workflows/ci.yml/badge.svg)](https://github.com/Trysac/u044-idempotency-keys/actions/workflows/ci.yml)

Idempotency-Key middleware for Node HTTP servers following draft-ietf-httpapi-idempotency-key-header: request fingerprinting, response replay, in-flight locking and pluggable storage.

## Problem

Clients retry POST requests after timeouts and create duplicate payments or orders. The Idempotency-Key header pattern prevents this but requires storing responses, detecting key reuse with a different body, handling concurrent duplicates and scoping keys so one user cannot replay another user's response. This library implements the pattern framework-agnostically with a storage interface and a bounded in-memory store.

## Install

```sh
npm install @trysac/idempotency-keys
```

Requires Node.js 20 or newer. The package ships ES modules with TypeScript declarations and has no runtime dependencies.

## Usage

Mount the middleware before your handler. If a body parser has already read the request, store its raw bytes in `req.rawBody` (for example in a `verify` hook) so the fingerprint uses them. Otherwise the middleware reads the unread request stream and answers 413 when it exceeds `maxBodyBytes`.

```ts
import { createServer } from "node:http";
import { MemoryStore, createIdempotency } from "@trysac/idempotency-keys";

const idempotency = createIdempotency({ store: new MemoryStore(), scope: () => "tenant-1" });

createServer((req, res) => {
  void idempotency(req, res, () => { res.end("created"); });
}).listen(3000);
```

## API

| Export | Description |
|---|---|
| `createIdempotency(options)` | Returns a `(req, res, next) => Promise<void>` middleware. Throws `IdempotencyError` with code `INVALID_OPTIONS` for invalid options. |
| `MemoryStore` | Bounded in-memory store: `new MemoryStore({ clock?, maxEntries? })`, default `maxEntries` 100000. Locks and completed entries share the budget. |
| `IdempotencyStore` | Storage interface with `get`, `acquire`, `save` and `release`. Implement it to use another backend. |
| `fingerprint(method, pathWithQuery, body, maxBodyBytes?)` | Lowercase SHA-256 hex of the method, target and SHA-256 of the body. Throws `BODY_TOO_LARGE` above `maxBodyBytes` (default 1 MiB). |
| `parseIdempotencyKey(raw, unquoted?)` | Parses an Idempotency-Key header value (RFC 9651 sf-string, or an unquoted key when `unquoted` is true). Throws `KEY_INVALID`. |
| `IdempotencyError` | Error class with a stable `code` property. |

Options of `createIdempotency`:

- `store` and `scope` (required). `scope(req)` returns the tenant or user id; return an empty string only for global keys.
- `header`: header name, default `idempotency-key`.
- `ttlMs`: lifetime of stored responses, default 86400000.
- `lockTtlMs`: lifetime of the in-flight lock, default 60000.
- `required`: answer 400 `KEY_REQUIRED` when the header is missing, default false.
- `methods`: methods that are made idempotent, default `POST` and `PATCH`.
- `replayHeaders`: response headers replayed to repeats, default `content-type`. `set-cookie` is never replayed.
- `maxBodyBytes`: request body limit, default 1048576.
- `maxResponseBytes`: captured response limit, default 1048576. Larger responses are delivered but not stored.
- `storeIf(status)`: decides whether a status is stored. Default: 200 to 499 except 408, 409, 425 and 429.
- `acceptUnquoted`: accept unquoted Stripe-style keys, default true.
- `clock`: clock in milliseconds, default `Date.now`.
- `onEvent(event)`: receives `stored`, `replayed`, `conflict`, `in_progress`, `rejected` or `not_stored` events with `keyHash` (SHA-256 hex of the store key, empty when no valid key exists) and an optional `code`. Errors thrown by the listener are ignored.

Error responses use RFC 9457 problem bodies with `Content-Type: application/problem+json`:

| Code | HTTP status | Meaning |
|---|---|---|
| `KEY_INVALID` | 400 | The header is malformed, too long or repeated. |
| `KEY_REQUIRED` | 400 | The header is missing and `required` is true. |
| `BODY_TOO_LARGE` | 413 | The request body exceeds `maxBodyBytes`. |
| `KEY_REUSED` | 422 | The key was used before with a different method, path, query or body. |
| `IN_PROGRESS` | 409 | A request with the same key is still running. |
| `STORE_FULL` | 503 | The store has no room for a new lock. |

A replayed response carries `idempotent-replayed: true`, a non-standard extension of this library.

Limits: keys are 1 to 255 characters after decoding; raw header values are at most 1024 characters; the store lives in process memory and is not shared between processes.

Security properties and threat model: see [docs/SECURITY.md](docs/SECURITY.md).

## Development

```sh
npm install
npm run check   # lint, format, types, tests with coverage, docs, secrets
```

See [AGENTS.md](AGENTS.md) for the full command list and [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

## License

[MIT](LICENSE) © 2026 Miguel Gomez
