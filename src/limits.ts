/** Default maximum request body size in bytes (1 MiB). */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/** Default maximum captured response size in bytes (1 MiB). */
export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

/** Default maximum number of entries held by a MemoryStore. */
export const DEFAULT_MAX_ENTRIES = 100_000;

/** Maximum accepted length of a raw Idempotency-Key header value. */
export const MAX_HEADER_VALUE_LENGTH = 1024;

/** Maximum length of a decoded idempotency key. */
export const MAX_KEY_LENGTH = 255;
