# Testing

## Tools

- [Vitest](https://vitest.dev/) runs the suites in `test/`.
- Coverage is collected with V8 (`@vitest/coverage-v8`) over `src/`.

## Test files

- `test/index.test.ts` is the only test file in the repository. It imports the public entry point `../src/index.js` and covers:
  - `IdempotencyError`: code, name and 200-character message truncation.
  - `parseIdempotencyKey`: valid sf-string and unquoted keys, rejected malformed values, the `unquoted` flag, non-string input and the 255-character boundary.
  - `fingerprint`: hash format, empty body, sensitivity to method, path, query and body, and the `maxBodyBytes` limit.
  - `MemoryStore`: expiry, eviction order at the `maxEntries` cap, `full` answers, lock and entry semantics, copies returned by `get`, and option validation.
  - `createIdempotency` through fake request and response objects: replay of status, headers and body bytes; 422 on key reuse; 409 while a request is in flight and recovery after the lock expires; `ttlMs` expiry; allowlisted replay headers; key handling through the middleware; method filtering and `required`; storage policy (`storeIf`, 5xx and retry-related statuses, `maxResponseBytes`); lock release on handler error and early close; response capture for `writeHead`, `write` and `end`.

## Commands

```sh
npm test            # vitest run --coverage
npx vitest          # watch mode while developing
npm run check       # every gate, including tests
```

## Rules

- Coverage must stay at or above 80 % for lines, branches, functions and statements, as configured in `vitest.config.ts`. Lowering the thresholds is not allowed.
- Tests go through the public entry point (`src/index.ts`) and assert observable behavior: return values, thrown errors and their codes, and HTTP responses.
- Each bug fix adds a test that fails without the fix.
- Tests are deterministic: they use an injected clock, no network and no shared state between tests.

## Reports

Coverage reports are written to `coverage/` (text summary and `lcov`). The folder is ignored by git.
