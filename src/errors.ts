/** Stable, machine-readable error codes of this library. */
export type IdempotencyErrorCode =
  | "KEY_INVALID"
  | "KEY_REUSED"
  | "IN_PROGRESS"
  | "KEY_REQUIRED"
  | "BODY_TOO_LARGE"
  | "STORE_FULL"
  | "INVALID_OPTIONS";

const MAX_MESSAGE_LENGTH = 200;

/**
 * Base error of the library.
 *
 * Messages are fixed descriptions, never contain the key, the body or any
 * secret, and are truncated to 200 characters.
 */
export class IdempotencyError extends Error {
  /** Stable machine-readable error code. */
  readonly code: IdempotencyErrorCode;

  /**
   * @param code - Machine-readable code.
   * @param message - Human-readable description (truncated to 200 characters).
   */
  constructor(code: IdempotencyErrorCode, message: string) {
    super(message.slice(0, MAX_MESSAGE_LENGTH));
    this.name = "IdempotencyError";
    this.code = code;
  }
}

/** Builds the error thrown for invalid configuration. */
export function invalidOptions(message: string): IdempotencyError {
  return new IdempotencyError("INVALID_OPTIONS", message);
}
