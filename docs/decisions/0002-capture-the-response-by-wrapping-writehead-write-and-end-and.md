# Capture the response by wrapping writeHead, write and end and save before delivering the final chunk

Status: accepted (generated, pending human review)

## Context

The middleware must store the handler's response for replay without knowing the web framework. Handlers may call writeHead, write and end in many forms, and a client that retries right after a response must not race the store write. The store interface also has no owner token, so a lock holder cannot prove it still owns a lock.

## Decision

Wrap res.writeHead, res.write and res.end on the response object, keep the status, allowlisted lowercased headers (never set-cookie) and body bytes up to maxResponseBytes, pass writes through immediately and defer the final end until the store save finished. Completed entries are never rewritten (save is a no-op when a live completed entry exists), failed or non-storable responses release the lock, and request errors are answered as RFC 9457 problem responses with a fixed JSON body. Keys are scoped by prefixing the scope and a NUL character, and events only carry the SHA-256 of that store key.

## Consequences

The middleware works with any framework that exposes Node's ServerResponse and a retry can never observe a missing entry after the client saw the first response. The cost is a small delay before the last chunk is flushed and one extra buffered copy of responses up to maxResponseBytes. Without lock tokens a holder whose lock expired can release a newer holder's lock, which is documented as a limitation; a future store interface revision could add owner tokens.
