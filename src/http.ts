/**
 * Bounded HTTP for quota reads and explicitly confirmed reset redemption.
 *
 * Safety invariants:
 * - GET reads; POST restricted to known reset routes. No URL credentials or redirects.
 * - 10s per request timeout, 128 KiB max body.
 * - Errors are sanitized: no raw upstream exception messages or bodies leak.
 */
import { UsageError } from "./types.ts";

export interface HttpResponse {
  status: number;
  /** Parsed JSON body, or null when the body is not valid JSON. */
  data: unknown;
  /** Validated server retry guidance (Retry-After, epoch ms from now); absent when none. */
  retryAfterMs?: number;
}

export type GetJson = (url: string, headers: Record<string, string>) => Promise<HttpResponse>;
export type PostJson = (url: string, headers: Record<string, string>, body: unknown) => Promise<HttpResponse>;

export interface HttpLimits {
  timeoutMs: number;
  maxBytes: number;
}

export const DEFAULT_HTTP_LIMITS: HttpLimits = { timeoutMs: 10_000, maxBytes: 128 * 1024 };

/** True when quota networking must be suppressed (mirrors Pi's PI_OFFLINE check). */
export function isOffline(): boolean {
  return process.env.PI_OFFLINE !== undefined;
}

function validateUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError("request", "Invalid request URL");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new UsageError("request", "Refusing non-https or credentialed request URL");
  }
  return parsed;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length > maxBytes) throw new UsageError("request", "Response too large");
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new UsageError("request", "Response too large");
    }
    chunks.push(value);
  }
  return chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");
}

/** Validated Retry-After guidance in ms (seconds form or HTTP-date), bounded to 1s..1h; junk stays undefined. */
export function parseRetryAfter(raw: string | null, now: number = Date.now()): number | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return Number.isFinite(ms) ? Math.min(Math.max(ms, 1_000), 3_600_000) : undefined;
  }
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.min(Math.max(date - now, 1_000), 3_600_000);
  return undefined;
}

/**
 * Create a bounded GET-JSON function. `signal` aborts package-owned waits;
 * fetch itself is also aborted by the per-request timeout.
 */
export function createGetJson(limits: HttpLimits = DEFAULT_HTTP_LIMITS, signal?: AbortSignal): GetJson {
  return (url, headers) => requestJson(url, headers, "GET", undefined, limits, signal);
}

/** No generic mutation transport: only the two inspected redemption routes. */
export function createPostJson(limits: HttpLimits = DEFAULT_HTTP_LIMITS, signal?: AbortSignal): PostJson {
  return (url, headers, body) => {
    const parsed = validateUrl(url);
    const allowed = url === "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"
      || (parsed.origin === "https://api.anthropic.com"
        && /^\/api\/organizations\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/reset_rate_limits$/.test(parsed.pathname)
        && parsed.search === "" && parsed.hash === "");
    if (!allowed) throw new UsageError("request", "Refusing unknown reset endpoint");
    return requestJson(url, { ...headers, "content-type": "application/json" }, "POST", JSON.stringify(body), limits, signal);
  };
}

async function requestJson(url: string, headers: Record<string, string>, method: "GET" | "POST",
  body: string | undefined, limits: HttpLimits, signal?: AbortSignal): Promise<HttpResponse> {
  validateUrl(url);
  if (isOffline()) throw new UsageError("canceled", "Quota networking suppressed (PI_OFFLINE)");
  if (signal?.aborted) throw new UsageError("canceled", "Request canceled");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new UsageError("request", "Network request failed");
    }
    let data: unknown = null;
    const text = await readBoundedBody(response, limits.maxBytes);
    if (text.length > 0) data = JSON.parse(text);
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    return retryAfterMs === undefined ? { status: response.status, data } : { status: response.status, data, retryAfterMs };
  } catch (error) {
    if (signal?.aborted) throw new UsageError("canceled", "Request canceled");
    if (controller.signal.aborted) throw new UsageError("timeout", "Request timed out");
    if (error instanceof UsageError) throw error;
    throw new UsageError("request", "Response was not valid JSON");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Bound a whole provider refresh (auth wait + requests) to `ms`.
 * Late results are discarded; underlying work is not claimed to be canceled.
 */
export async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new UsageError("timeout", "Provider refresh timed out")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
