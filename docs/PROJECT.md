# Project record: idempotency-keys

## Objective

Provide Idempotency-Key middleware for Node HTTP servers that follows draft-ietf-httpapi-idempotency-key-header. A retried request with the same key and the same method, path, query and body receives the stored response instead of running the handler a second time. A reused key with a different request is rejected with 422, and a concurrent duplicate receives 409 while the first request is still running.

Intended users are backend developers on Node HTTP servers who need safe retries for non-idempotent endpoints such as payments and order creation.

## Scope

In scope:

- The public API documented in the README: `createIdempotency`, `MemoryStore`, the `IdempotencyStore` interface, `fingerprint`, `parseIdempotencyKey` and `IdempotencyError`.
- Key parsing (sf-string and unquoted keys), request fingerprinting, response capture and replay, in-flight locking, RFC 9457 problem responses and an observability hook (`onEvent`).
- A bounded in-memory store with a configurable entry cap.

Out of scope:

- Persistent or distributed stores, including Redis and SQL stores. Only the in-memory store ships; other backends must implement `IdempotencyStore` themselves.
- Sharing state between processes or servers.
- Framework-specific adapters. The middleware uses the Node `req`, `res` and `next` shape.
- Body parsing. The caller provides `req.rawBody` or lets the middleware read the stream.
- Authentication and authorization. The caller supplies the scope value through `scope(req)`.

## Timeline

| Date | Milestone |
|---|---|
| 2026 | Repository created from the factory utility template. |

## Effort metrics

Recorded values only. Figures are added here when they are measured.

| Metric | Value | Source |
|---|---|---|
| Tokens (input / output) | 372843 / 142485 | factory ledger |
| Hours (human) | pending measurement | time log |
| Cost (USD) | 1.0502 | factory ledger |

## Factory run u044 (measured from API usage)

| Phase | Model | Batch | Input | Output | Cache write | Cache read | Cost (USD) |
|---|---|---|---|---|---|---|---|
| generation | claude-sonnet-5-5 | yes | 2817 | 119042 | 0 | 4473 | 0.5985 |
| fix-1 | claude-sonnet-5-5 | no | 6 | 747 | 7851 | 43178 | 0.0314 |
| fix-2 | claude-sonnet-5-5 | no | 8 | 1675 | 24974 | 73603 | 0.0866 |
| audit | claude-sonnet-5-5 | no | 10 | 3707 | 53595 | 85202 | 0.1796 |
| fix-3 | claude-sonnet-5-5 | no | 12 | 7474 | 23254 | 125807 | 0.1455 |
| docs | claude-haiku-5-5 | no | 37727 | 9840 | 0 | 0 | 0.0087 |

Total: $1.0502. Prices: Anthropic list prices.
