/**
 * Bounded, read-only HTTP for quota endpoints.
 *
 * Safety rules (from PLAN.md):
 * - GET only, fixed https URLs, no URL credentials, redirects rejected.
 * - 10s per request timeout, 128 KiB max body.
 * - Errors are sanitized: no raw upstream exception messages or bodies leak.
 */
import { UsageError } from "./types.ts";

export interface HttpResponse {
  status: number;
  /** Parsed JSON body, or null when the body is not valid JSON. */
  data: unknown;
}

export type GetJson = (url: string, headers: Record<string, string>) => Promise<HttpResponse>;

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

/**
 * Create a bounded GET-JSON function. `signal` aborts package-owned waits;
 * fetch itself is also aborted by the per-request timeout.
 */
export function createGetJson(limits: HttpLimits = DEFAULT_HTTP_LIMITS, signal?: AbortSignal): GetJson {
  return async (url, headers) => {
    validateUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener("abort", onOuterAbort, { once: true });
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers,
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (signal?.aborted) throw new UsageError("canceled", "Request canceled");
      if (controller.signal.aborted) throw new UsageError("timeout", "Request timed out");
      // ponytail: fetch rejections carry local network detail; never surface them.
      throw new UsageError("request", "Network request failed");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onOuterAbort);
    }
    let data: unknown = null;
    try {
      const body = await readBoundedBody(response, limits.maxBytes);
      if (body.length > 0) data = JSON.parse(body);
    } catch (error) {
      if (error instanceof UsageError) throw error;
      throw new UsageError("request", "Response was not valid JSON");
    }
    return { status: response.status, data };
  };
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
