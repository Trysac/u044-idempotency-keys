# Security practices

How this repository keeps the package and its users safe. The disclosure policy is in [../SECURITY.md](../SECURITY.md).

## Threat model

The library protects the server against duplicate execution of non-idempotent requests and limits resource use caused by requests. It is not an authentication or authorization layer.

Defended:

- Duplicate execution of a request retried with the same key, method, path, query and body: the stored response is replayed and the handler does not run again.
- Key reuse with a different request: answered with 422 `KEY_REUSED` and the handler does not run.
- Concurrent duplicates while the first request runs: answered with 409 `IN_PROGRESS`.
- Cross-tenant replay when the caller passes distinct scope values: the store key is the scope joined with the key, so the same key under two scopes is independent.
- Oversized input: request bodies above `maxBodyBytes` get 413 and are not fingerprinted; header values above 1024 characters and keys above 255 characters are rejected with 400 `KEY_INVALID`.
- Unbounded memory growth in `MemoryStore`: entries are capped by `maxEntries` (default 100000); expired items are purged first, then the oldest completed entry is evicted, and new locks are refused with 503 when only live locks remain.
- Oversized responses: responses above `maxResponseBytes` are delivered but not stored.
- Cookies: `set-cookie` is never stored for replay, even when listed in `replayHeaders`.
- Information leakage through events and errors: `onEvent` carries only the SHA-256 hex of the store key, and problem bodies and error messages never contain the raw key or the request body.

Not defended:

- Authentication and authorization of the caller. The `scope` function must return a value that identifies the tenant or user; an empty scope shares keys globally.
- Data loss or duplicate execution across processes or restarts: `MemoryStore` lives in process memory, so a restart or a second server instance does not see earlier keys.
- Expired lock holders: the store has no fencing guarantee beyond the owner token passed to `acquire`, `save` and `release`. A holder whose lock expired while its handler still runs can finish after another request has taken the key; its save is ignored only when a completed entry or a lock held by another owner is live.
- Handlers that have side effects before a failure: a handler that throws or responds with a non-stored status is retried by the client and runs again.
- Replay of responses that depend on time, randomness or request state outside the fingerprint.
- Request smuggling, slow-body (slowloris) attacks and other transport-level attacks; these belong to the HTTP server and its proxy.
- Clients that send a different key for each retry.
- Replayed responses are marked with the non-standard `idempotent-replayed: true` header; this reveals that a response was replayed.

## Secrets

- No secrets, tokens or credentials in the repository, commit history, logs or prompts.
- `gitleaks` runs as the last step of `npm run check` and as a dedicated CI job. Its configuration is `.gitleaks.toml`.
- Publishing credentials live only in the CI secret store or the maintainer's local npm configuration.

## Dependencies

- The library has no runtime dependencies. Development dependencies are limited to the toolchain listed in [STACK.md](STACK.md).
- Dependabot opens weekly updates for npm packages and GitHub Actions.
- The generated `package-lock.json` is committed so installs are reproducible.

## Code

- No `eval`, dynamic `Function` construction or shelling out from library code.
- Inputs from callers are validated; invalid options throw `IdempotencyError` with code `INVALID_OPTIONS`, and invalid request keys produce `KEY_INVALID` problem responses.

## Publishing

- Packages are published from a clean checkout after `npm run check` passes.
- Only `dist/` is included in the published tarball.
