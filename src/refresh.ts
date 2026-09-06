/**
 * In-memory quota cache, refresh scheduling, deduplication, and backoff for
 * the automatic active-provider footer indicator.
 *
 * Safety rules (from PLAN.md):
 * - Cache lives in memory only, partitioned by a salted in-process credential
 *   fingerprint; credentials never appear in keys or persisted artifacts, and
 *   another account's cached result is never served.
 * - Command, timer, and event refreshes for the same provider share one
 *   in-flight promise; backoff prevents request storms.
 * - Automatic networking is TUI-only and suppressed under PI_OFFLINE.
 * - Obsolete results (session replacement, provider switch, caller timeout)
 *   are discarded and never update the footer or cache.
 * - Reaching a reset time means fresh data is needed, never assumed
 *   replenishment.
 */
import { createHash, randomUUID } from "node:crypto";
import type { AuthGateway } from "./auth.ts";
import { resolveQuotaAuth } from "./auth.ts";
import { bounded, createGetJson, DEFAULT_HTTP_LIMITS, isOffline, type GetJson } from "./http.ts";
import { UsageError, type ProviderError, type ProviderUsage, type QuotaAdapter } from "./types.ts";
import { formatFooterError, formatFooterText } from "./ui.ts";

export const STATUS_KEY = "usage";
export const POLL_INTERVAL_MS = 5 * 60_000;
/** agent_settled only refreshes when cached data is at least this old. */
export const EVENT_MIN_AGE_MS = 60_000;

const PROVIDER_BOUND_MS = 30_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 5 * 60_000;

/** Sanitized error result wrapper shared with the command view. */
export function errorUsage(adapter: QuotaAdapter, error: UsageError, capturedAt: number): ProviderUsage {
  return {
    providerId: adapter.id,
    providerName: adapter.name,
    domainLabel: adapter.domainLabel,
    capturedAt,
    windows: [],
    error: { kind: error.kind, message: error.message },
  };
}

/** Session-scoped services the monitor needs from the Pi context. */
export interface MonitorSession {
  gateway: AuthGateway;
  mode: string;
  setStatus(key: string, text: string | undefined): void;
}

export interface UsageMonitorOptions {
  adapters: readonly QuotaAdapter[];
  /** Injectable clock (fake-timer tests). Defaults to Date.now. */
  now?(): number;
  /** Injectable GET factory (tests); production uses the bounded HTTP layer. */
  createRequester?(signal: AbortSignal): GetJson;
}

interface CacheEntry {
  fingerprint: string;
  usage: ProviderUsage;
}

interface BackoffState {
  until: number;
  failures: number;
}

interface ErrorState {
  kind: ProviderError["kind"];
  message: string;
}

/** True when any quota window's reset time has passed: fresh data is needed. */
function resetPassed(usage: ProviderUsage, now: number): boolean {
  return usage.windows.some((window) => window.resetsAt !== undefined && window.resetsAt <= now);
}

export class UsageMonitor {
  private readonly adapters: readonly QuotaAdapter[];
  private readonly adapterById = new Map<string, QuotaAdapter>();
  private readonly now: () => number;
  private readonly createRequester: (signal: AbortSignal) => GetJson;
  /** Per-process (per-extension-instance) salt for credential fingerprints. */
  private readonly salt = randomUUID();

  private session: MonitorSession | undefined;
  private controller: AbortController | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped on session replacement; in-flight completions compare and discard. */
  private generation = 0;

  private activeProviderId: string | undefined;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<ProviderUsage>>();
  private readonly backoff = new Map<string, BackoffState>();
  private readonly lastError = new Map<string, ErrorState>();

  constructor(options: UsageMonitorOptions) {
    this.adapters = options.adapters;
    for (const adapter of options.adapters) this.adapterById.set(adapter.id, adapter);
    this.now = options.now ?? (() => Date.now());
    this.createRequester = options.createRequester ?? ((signal) => createGetJson(DEFAULT_HTTP_LIMITS, signal));
  }

  get hasSession(): boolean {
    return this.session !== undefined;
  }

  adapterFor(providerId: string): QuotaAdapter | undefined {
    return this.adapterById.get(providerId);
  }

  /**
   * Cached result verified against the provider's CURRENT credentials via
   * Pi auth resolution. This is the only way cached data is served: another
   * account's result can never be exposed after a credential change.
   */
  async serveCached(providerId: string): Promise<ProviderUsage | undefined> {
    const session = this.session;
    const adapter = this.adapterById.get(providerId);
    const entry = this.cache.get(providerId);
    if (session === undefined || adapter === undefined || entry === undefined) return undefined;
    const auth = await resolveQuotaAuth(session.gateway, providerId, adapter.officialOrigin, adapter.allowedProviderOrigin);
    if (auth instanceof UsageError) return undefined;
    if (this.fingerprintOf(auth.apiKey) !== entry.fingerprint) return undefined;
    return entry.usage;
  }

  /**
   * Session lifecycle entry point. Resets per-session state (timers, in-flight
   * controller, generation), refreshes the active provider, and starts the
   * five-minute poll. Idempotent; automatic work is TUI-only and offline-aware.
   */
  startSession(session: MonitorSession, activeProviderId: string | undefined): void {
    this.stopSessionWork();
    this.session = session;
    this.activeProviderId = activeProviderId;
    void this.renderFooter(); // clears status for unsupported/unconfigured active providers
    if (!this.autoNetworkingAllowed()) return;
    void this.refreshActive("session");
    this.schedulePoll();
  }

  /** Refresh captured session references without resetting state. */
  updateSession(session: MonitorSession): void {
    this.session = session;
  }

  /**
   * Model change: refresh when the active provider actually changed. Switching
   * models within one provider does not alter that provider's quota, and
   * refreshing per model-cycle would create request storms.
   */
  setActiveProvider(providerId: string | undefined): void {
    if (providerId === this.activeProviderId) return;
    this.activeProviderId = providerId;
    if (!this.autoNetworkingAllowed()) return;
    void this.refreshActive("model");
    void this.renderFooter();
  }

  /** agent_settled: opportunistic refresh of fresh-enough data only. */
  async onAgentSettled(): Promise<void> {
    if (!this.autoNetworkingAllowed()) return;
    const providerId = this.activeProviderId;
    if (providerId === undefined) return;
    const cached = await this.serveCached(providerId);
    if (cached !== undefined) {
      const now = this.now();
      if (now - cached.capturedAt < EVENT_MIN_AGE_MS && !resetPassed(cached, now)) return;
    }
    await this.refresh(providerId, "settled");
  }

  /** Manual /usage refresh: bypasses cache age, respects backoff and offline. */
  refreshProvider(adapter: QuotaAdapter): Promise<ProviderUsage> {
    return this.refresh(adapter.id, "command");
  }

  /** Clear timers, abort package-owned requests, discard late results, drop status. */
  shutdown(): void {
    this.stopSessionWork();
    this.session?.setStatus(STATUS_KEY, undefined);
    this.session = undefined;
    this.activeProviderId = undefined;
  }

  private stopSessionWork(): void {
    this.generation++;
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.controller?.abort();
    this.controller = undefined;
  }

  private autoNetworkingAllowed(): boolean {
    return this.session !== undefined && this.session.mode === "tui" && !isOffline();
  }

  private schedulePoll(): void {
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    // unref: the poll must never keep a process (or test run) alive by itself.
    const timer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.pollTick();
    }, POLL_INTERVAL_MS);
    timer.unref?.();
    this.pollTimer = timer;
  }

  private async pollTick(): Promise<void> {
    try {
      const providerId = this.activeProviderId;
      if (this.autoNetworkingAllowed() && providerId !== undefined) {
        await this.refresh(providerId, "poll");
      }
    } finally {
      // Stop rescheduling once the session is gone (shutdown/replacement).
      if (this.session !== undefined) this.schedulePoll();
    }
  }

  private async refreshActive(trigger: "session" | "model"): Promise<void> {
    const providerId = this.activeProviderId;
    if (providerId === undefined) return;
    await this.refresh(providerId, trigger);
  }

  private fingerprintOf(apiKey: string): string {
    return createHash("sha256").update(this.salt).update(apiKey).digest("hex");
  }

  private ensureController(): AbortController {
    if (this.controller === undefined) this.controller = new AbortController();
    return this.controller;
  }

  private refresh(providerId: string, trigger: "session" | "model" | "settled" | "poll" | "command"): Promise<ProviderUsage> {
    // Deduplicate command, timer, and event requests for the same provider.
    const existing = this.inFlight.get(providerId);
    if (existing !== undefined) return existing;

    const adapter = this.adapterById.get(providerId);
    const session = this.session;
    if (adapter === undefined || session === undefined) {
      return Promise.resolve({
        providerId,
        providerName: providerId,
        domainLabel: "quota",
        capturedAt: this.now(),
        windows: [],
        error: { kind: "canceled", message: "No active session for this provider" },
      });
    }

    const generation = this.generation;
    const promise = this.runRefresh(adapter, session, generation);
    this.inFlight.set(providerId, promise);
    return promise.finally(() => {
      if (this.inFlight.get(providerId) === promise) this.inFlight.delete(providerId);
    });
  }

  private async runRefresh(
    adapter: QuotaAdapter,
    session: MonitorSession,
    generation: number,
  ): Promise<ProviderUsage> {
    const adapterId = adapter.id;
    if (isOffline()) {
      return errorUsage(adapter, new UsageError("canceled", "Quota networking suppressed (PI_OFFLINE)"), this.now());
    }
    if (!session.gateway.isConfigured(adapterId)) {
      return errorUsage(adapter, new UsageError("not-configured", "No credentials configured for this provider"), this.now());
    }
    // Manual queries bypass cache age but respect server-imposed backoff.
    const back = this.backoff.get(adapterId);
    if (back !== undefined && back.until > this.now()) {
      const cached = await this.serveCached(adapterId);
      return cached !== undefined
        ? cached
        : errorUsage(adapter, new UsageError("canceled", "Refresh deferred: provider backoff active"), this.now());
    }

    // The caller may give up on this refresh (per-provider 30s bound); late
    // completions must not touch cache or footer.
    let callerGaveUp = false;
    const work = async (): Promise<ProviderUsage> => {
      const auth = await resolveQuotaAuth(session.gateway, adapterId, adapter.officialOrigin, adapter.allowedProviderOrigin);
      if (auth instanceof UsageError) {
        if (this.generation === generation && !callerGaveUp) this.noteFailure(adapterId, undefined);
        return errorUsage(adapter, auth, this.now());
      }
      const fingerprint = this.fingerprintOf(auth.apiKey);
      // Capture server retry guidance from non-2xx responses without
      // touching adapter contracts.
      let retryAfterMs: number | undefined;
      const getJsonBase = this.createRequester(this.ensureController().signal);
      const getJson: GetJson = async (url, headers) => {
        const response = await getJsonBase(url, headers);
        if ((response.status < 200 || response.status >= 300) && response.retryAfterMs !== undefined) {
          retryAfterMs = response.retryAfterMs;
        }
        return response;
      };
      try {
        const usage = await adapter.fetchQuota(auth, getJson);
        if (callerGaveUp || this.generation !== generation) return usage; // obsolete
        this.backoff.delete(adapterId);
        this.lastError.delete(adapterId);
        this.cache.set(adapterId, { fingerprint, usage });
        void this.renderFooter();
        return usage;
      } catch (error) {
        const usageError = error instanceof UsageError ? error : new UsageError("request", "Provider refresh failed");
        if (this.generation === generation && !callerGaveUp) {
          // Canceled means our own abort (shutdown); no failure to back off from.
          if (usageError.kind !== "canceled") this.noteFailure(adapterId, retryAfterMs);
          this.lastError.set(adapterId, { kind: usageError.kind, message: usageError.message });
          void this.renderFooter();
        }
        return errorUsage(adapter, usageError, this.now());
      }
    };
    try {
      return await bounded(work(), PROVIDER_BOUND_MS);
    } catch (error) {
      callerGaveUp = true;
      const usageError = error instanceof UsageError ? error : new UsageError("request", "Provider refresh failed");
      if (this.generation === generation) {
        this.noteFailure(adapterId, undefined);
        this.lastError.set(adapterId, { kind: usageError.kind, message: usageError.message });
        void this.renderFooter();
      }
      return errorUsage(adapter, usageError, this.now());
    }
  }

  /** Exponential backoff for automatic failures; valid server guidance is the floor. */
  private noteFailure(providerId: string, serverRetryMs: number | undefined): void {
    const back = this.backoff.get(providerId) ?? { until: 0, failures: 0 };
    back.failures++;
    const exponential = Math.min(BACKOFF_BASE_MS * 2 ** (back.failures - 1), BACKOFF_MAX_MS);
    back.until = this.now() + Math.max(exponential, serverRetryMs ?? 0);
    this.backoff.set(providerId, back);
  }

  private async renderFooter(): Promise<void> {
    const session = this.session;
    if (session === undefined || session.mode !== "tui" || isOffline()) return;
    const providerId = this.activeProviderId;
    const adapter = providerId !== undefined ? this.adapterById.get(providerId) : undefined;
    if (adapter === undefined || providerId === undefined || !session.gateway.isConfigured(providerId)) {
      session.setStatus(STATUS_KEY, undefined);
      return;
    }
    const cached = await this.serveCached(providerId);
    if (cached !== undefined) {
      const error = this.lastError.get(providerId);
      session.setStatus(STATUS_KEY, formatFooterText(cached, { now: this.now(), stale: error !== undefined }));
      return;
    }
    const error = this.lastError.get(providerId);
    if (error !== undefined) {
      const back = this.backoff.get(providerId);
      const retryIn = back !== undefined && back.until > this.now() ? back.until - this.now() : undefined;
      session.setStatus(STATUS_KEY, formatFooterError(error.kind, retryIn));
      return;
    }
    // First refresh still in flight: no status yet.
    session.setStatus(STATUS_KEY, undefined);
  }
}
