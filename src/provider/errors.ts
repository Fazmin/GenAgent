/**
 * Provider Error Classification and Retry
 *
 * Design:
 * - Error classification: categorize LLM API errors into limited categories to decide retry strategy
 * - Exponential backoff: avoid frantic retries during rate-limiting/overload
 * - Context Overflow: handled separately, triggers auto-compact rather than simple retry
 */

// ============== Error Classification ==============

/**
 * Failover Reason
 */
export type FailoverReason =
  | "rate_limit"
  | "auth"
  | "timeout"
  | "billing"
  | "format"
  | "unknown";

/**
 * FailoverError — error with classification information
 *
 * - Carries error reason, provider, model, and other metadata
 * - Upper layers can decide to retry/switch/abort based on reason
 */
export class FailoverError extends Error {
  readonly reason: FailoverReason;
  readonly provider?: string;
  readonly model?: string;
  readonly status?: number;

  constructor(
    message: string,
    params: {
      reason: FailoverReason;
      provider?: string;
      model?: string;
      status?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: params.cause });
    this.name = "FailoverError";
    this.reason = params.reason;
    this.provider = params.provider;
    this.model = params.model;
    this.status = params.status;
  }
}

export function isFailoverError(err: unknown): err is FailoverError {
  return err instanceof FailoverError;
}

// ============== Error Pattern Matching ==============

const RATE_LIMIT_PATTERNS = [
  "rate_limit",
  "too many requests",
  "429",
  "exceeded quota",
  "resource exhausted",
  "quota exceeded",
  "resource_exhausted",
  "usage limit",
];

const TIMEOUT_PATTERNS = [
  "timeout",
  "timed out",
  "deadline exceeded",
  "context deadline exceeded",
];

const AUTH_PATTERNS = [
  "invalid_api_key",
  "incorrect api key",
  "invalid token",
  "authentication",
  "unauthorized",
  "forbidden",
  "access denied",
  "expired",
  "401",
  "403",
];

const BILLING_PATTERNS = [
  "402",
  "payment required",
  "insufficient credits",
  "credit balance",
];

const FORMAT_PATTERNS = [
  "string should match pattern",
  "invalid request format",
];

const CONTEXT_OVERFLOW_PATTERNS = [
  "request_too_large",
  "request exceeds the maximum size",
  "context length exceeded",
  "maximum context length",
  "prompt is too long",
  "exceeds model context window",
  "context overflow",
];

function matchesAny(message: string, patterns: string[]): boolean {
  const lower = message.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

/**
 * Context Overflow Detection
 *
 * - Handled separately from normal failover
 * - Triggers auto-compact rather than simple retry
 */
export function isContextOverflowError(message?: string): boolean {
  if (!message) return false;
  if (matchesAny(message, CONTEXT_OVERFLOW_PATTERNS)) return true;
  // 413 + "too large" combination
  const lower = message.toLowerCase();
  if (lower.includes("413") && lower.includes("too large")) return true;
  return false;
}

export function isRateLimitError(message?: string): boolean {
  return !!message && matchesAny(message, RATE_LIMIT_PATTERNS);
}

export function isTimeoutError(message?: string): boolean {
  return !!message && matchesAny(message, TIMEOUT_PATTERNS);
}

export function isAuthError(message?: string): boolean {
  return !!message && matchesAny(message, AUTH_PATTERNS);
}

/**
 * Classify error reason
 *
 * Matches by priority: billing > auth > rate_limit > timeout > format > null
 */
export function classifyFailoverReason(message: string): FailoverReason | null {
  if (matchesAny(message, BILLING_PATTERNS)) return "billing";
  if (matchesAny(message, AUTH_PATTERNS)) return "auth";
  if (matchesAny(message, RATE_LIMIT_PATTERNS)) return "rate_limit";
  if (matchesAny(message, TIMEOUT_PATTERNS)) return "timeout";
  if (matchesAny(message, FORMAT_PATTERNS)) return "format";
  return null;
}

/**
 * Determine if an error should trigger failover (switch profile / model)
 */
export function isFailoverErrorMessage(message?: string): boolean {
  if (!message) return false;
  const reason = classifyFailoverReason(message);
  // timeout does not trigger failover (may just be network jitter)
  return reason !== null && reason !== "timeout";
}

// ============== Exponential Backoff Retry ==============

/**
 * Retry configuration
 */
export interface RetryOptions {
  /** Maximum retry attempts (default 3) */
  attempts?: number;
  /** Minimum delay (default 300ms) */
  minDelayMs?: number;
  /** Maximum delay (default 30000ms) */
  maxDelayMs?: number;
  /** Jitter coefficient 0-1 (default 0.1) */
  jitter?: number;
  /** Log label */
  label?: string;
  /** Whether to retry (return false to throw immediately) */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Retry callback */
  onRetry?: (info: { attempt: number; delay: number; error: unknown }) => void;
}

/**
 * Async retry with exponential backoff
 *
 * Backoff formula: delay = minDelayMs * 2^(attempt-1)
 * With jitter:    delay *= (1 + random(-jitter, +jitter))
 * Clamped:        clamp(minDelayMs, maxDelayMs)
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const attempts = options?.attempts ?? 3;
  const minDelayMs = options?.minDelayMs ?? 300;
  const maxDelayMs = options?.maxDelayMs ?? 30_000;
  const jitter = options?.jitter ?? 0.1;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === attempts) break;
      if (options?.shouldRetry && !options.shouldRetry(err, attempt)) break;

      // Exponential backoff
      let delay = minDelayMs * 2 ** (attempt - 1);

      // Jitter
      if (jitter > 0) {
        const offset = (Math.random() * 2 - 1) * jitter;
        delay *= 1 + offset;
      }

      // Clamp
      delay = Math.max(Math.min(delay, maxDelayMs), minDelayMs);

      options?.onRetry?.({ attempt, delay, error: err });

      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============== Describe Error ==============

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
