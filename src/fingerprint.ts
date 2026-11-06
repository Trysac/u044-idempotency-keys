import { createHash } from "node:crypto";
import { IdempotencyError } from "./errors.js";
import { DEFAULT_MAX_BODY_BYTES } from "./limits.js";

/** Returns the lowercase hexadecimal SHA-256 digest of `data`. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Computes the request fingerprint (draft-ietf-httpapi-idempotency-key-header,
 * section 2.4): the SHA-256 hex digest of
 * `METHOD + "\n" + pathWithQuery + "\n" + sha256hex(body)`.
 *
 * @param method - HTTP method, upper-cased before hashing.
 * @param pathWithQuery - Request target including the query string.
 * @param body - Raw request body bytes.
 * @param maxBodyBytes - Size limit for `body`. Defaults to 1 MiB.
 * @returns Lowercase hexadecimal digest.
 * @throws {IdempotencyError} With code `BODY_TOO_LARGE` when `body` is larger
 * than `maxBodyBytes`.
 */
export function fingerprint(
  method: string,
  pathWithQuery: string,
  body: Uint8Array,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
): string {
  if (body.byteLength > maxBodyBytes) {
    throw new IdempotencyError("BODY_TOO_LARGE", "body is too large");
  }
  const bodyHash = sha256Hex(body);
  return sha256Hex(`${method.toUpperCase()}\n${pathWithQuery}\n${bodyHash}`);
}
