# Architecture

## Overview

`@trysac/idempotency-keys` is a small TypeScript library published to npm as ES modules with type declarations. It implements Idempotency-Key middleware for Node HTTP servers following draft-ietf-httpapi-idempotency-key-header: key parsing, request fingerprinting, response capture and replay, in-flight locking and pluggable storage. The only imports are Node built-in modules (`node:crypto`, and type-only imports from `node:http`).

## Modules

| Module | Responsibility |
|---|---|
| `src/index.ts` | Public API. Re-exports the symbols consumers import. |
| `src/middleware.ts` | `createIdempotency`: option resolution, check order, response capture and replay, problem responses, events. |
| `src/key.ts` | `parseIdempotencyKey`: sf-string and unquoted key parsing. |
| `src/fingerprint.ts` | `fingerprint` and `sha256Hex`. |
| `src/store.ts` | `IdempotencyStore` interface, the `StoredResponse` type and `MemoryStore`. |
| `src/errors.ts` | `IdempotencyError`, its code type and `invalidOptions`. |
| `src/limits.ts` | Default and maximum limits (body, response, entries, header and key lengths). |

## Boundaries

- Runtime dependencies: none. Node built-in modules only.
- Import time performs no I/O. `createIdempotency` and `MemoryStore` only validate their arguments and keep state in memory.
- Invalid configuration throws `IdempotencyError` with code `INVALID_OPTIONS`. Request-level failures are never thrown to the caller; they become RFC 9457 problem responses, except for errors thrown by the wrapped handler, which are re-thrown after the lock is released.
- Storage is abstracted by `IdempotencyStore`. The bundled `MemoryStore` is the only implementation in this repository.

## Request flow

The middleware checks, in order: method filter, header presence, key parsing, body size, fingerprint, stored response, lock acquisition, and finally the handler. The response is captured through wrapped `writeHead`, `write` and `end` methods and saved before it is sent to the client.

## Build and distribution

`npm run build` compiles `src/` to `dist/` with `tsconfig.build.json`. Only `dist/` is published (`files` in `package.json`).

## Decisions

Architectural decisions are recorded in [decisions/](decisions/), starting with [0001](decisions/0001-record-architecture-decisions.md).
