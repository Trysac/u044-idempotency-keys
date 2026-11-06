import { IdempotencyError } from "./errors.js";
import { MAX_HEADER_VALUE_LENGTH, MAX_KEY_LENGTH } from "./limits.js";

const UNQUOTED_KEY = /^[\x21\x23-\x7E]{1,255}$/;
const SPACE = 0x20;
const DQUOTE = '"';
const BACKSLASH = "\\";

function invalidKey(message: string): IdempotencyError {
  return new IdempotencyError("KEY_INVALID", message);
}

function parseSfString(value: string): string {
  let decoded = "";
  let closed = false;
  for (let i = 1; i < value.length && !closed; i += 1) {
    const code = value.charCodeAt(i);
    if (code < SPACE || code > 0x7e) {
      throw invalidKey("key contains a character outside 0x20-0x7E");
    }
    const char = value.charAt(i);
    if (char === BACKSLASH) {
      const escaped = value.charAt(i + 1);
      if (escaped !== DQUOTE && escaped !== BACKSLASH) {
        throw invalidKey("key contains an invalid escape sequence");
      }
      decoded += escaped;
      i += 1;
    } else if (char === DQUOTE) {
      if (i !== value.length - 1) {
        throw invalidKey("key has trailing characters or parameters");
      }
      closed = true;
    } else {
      decoded += char;
    }
  }
  if (!closed) {
    throw invalidKey("key string is not terminated");
  }
  if (decoded.length < 1 || decoded.length > MAX_KEY_LENGTH) {
    throw invalidKey("key must be 1 to 255 characters long");
  }
  return decoded;
}

/**
 * Parses the value of an Idempotency-Key header field.
 *
 * Leading and trailing spaces are ignored. A value starting with a double
 * quote is parsed as an RFC 9651 sf-string (characters 0x20-0x7E, a backslash
 * only before a double quote or a backslash, no trailing characters and no
 * parameters). Otherwise, when `unquoted` is true, the value must match
 * `^[\x21\x23-\x7E]{1,255}$` (Stripe-style keys). Decoded keys are 1-255
 * characters long.
 *
 * @param raw - The raw header value (at most 1024 characters).
 * @param unquoted - Accept unquoted keys. Defaults to true.
 * @returns The decoded key.
 * @throws {IdempotencyError} With code `KEY_INVALID` for any malformed value.
 */
export function parseIdempotencyKey(raw: string, unquoted = true): string {
  if (typeof raw !== "string" || raw.length > MAX_HEADER_VALUE_LENGTH) {
    throw invalidKey("key header is missing or too long");
  }
  let start = 0;
  let end = raw.length;
  while (start < end && raw.charCodeAt(start) === SPACE) {
    start += 1;
  }
  while (end > start && raw.charCodeAt(end - 1) === SPACE) {
    end -= 1;
  }
  const value = raw.slice(start, end);
  if (value.startsWith(DQUOTE)) {
    return parseSfString(value);
  }
  if (!unquoted) {
    throw invalidKey("unquoted keys are not accepted");
  }
  if (!UNQUOTED_KEY.test(value)) {
    throw invalidKey("unquoted key has invalid characters or length");
  }
  return value;
}
