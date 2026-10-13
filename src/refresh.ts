/**
 * In-memory quota cache, refresh scheduling, deduplication, and backoff for
 * the automatic active-provider footer indicator.
 *
 * Safety invariants:
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
import type { SharedClaim, SharedCoordination } from "./coordination.ts";
import { bounded, createGetJson, createPostJson, DEFAULT_HTTP_LIMITS, isOffline, type GetJson, type PostJson } from "./http.ts";
import { attachResets, availableResetOffers, lowQuotaResetAvailable } from "./resets.ts";
import { UsageError, type ProviderError, type ProviderUsage, type QuotaAdapter, type ResetOffer } from "./types.ts";
import { DEFAULT_USAGE_SETTINGS, type ProviderUsageSettings, type UsageSettings } from "./settings.ts";
import { formatFooterError, formatFooterText } from "./ui.ts";

export const STATUS_KEY = "usage";
export const POLL_INTERVAL_MS = DEFAULT_USAGE_SETTINGS.pollIntervalMinutes * 60_000;
/** agent_settled only refreshes when cached data is at least this old. */
export const EVENT_MIN_AGE_MS = 60_000;

const PROVIDER_BOUND_MS = 30_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** Auto triggers skip when another running instance refreshed this account within this window. */
const SHARED_FRESH_MS = 60_000;

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
  /** False means temporarily suppressed by the command UI. */
  notify?(message: string): boolean | void;
}

export interface ResetSelection {
  providerId: string;
  offers: ResetOffer[];
  usage: ProviderUsage;
  fingerprint: string;
  generation: number;
}

export interface UsageMonitorOptions {
  adapters: readonly QuotaAdapter[];
  /** Injectable clock (fake-timer tests). Defaults to Date.now. */
  now?(): number;
  /** Injectable GET factory (tests); production uses the bounded HTTP layer. */
  createRequester?(signal: AbortSignal): GetJson;
  createResetRequester?(signal: AbortSignal): PostJson;
  settings?: UsageSettings;
  /** Cross-instance timing/backoff sharing; absent keeps per-instance behavior. */
  coordination?: SharedCoordination;
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
  private settings: UsageSettings;
  private readonly coordination: SharedCoordination | undefined;
  private readonly createResetRequester: (signal: AbortSignal) => PostJson;
  private readonly resetting = new Set<string>();
  private readonly attemptedResets = new Set<string>();
  private readonly resetNotices = new Set<string>();
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
    this.settings = options.settings ?? { ...DEFAULT_USAGE_SETTINGS };
    this.coordination = options.coordination;
    this.createResetRequester = options.createResetRequester ?? ((signal) => createPostJson(DEFAULT_HTTP_LIMITS, signal));
  }

  get hasSession(): boolean {
    return this.session !== undefined;
  }

  /** True when the provider's reporting is fully disabled by settings. */
  isReportingDisabled(providerId: string): boolean {
    return this.providerEntry(providerId).disabled === true;
  }

  private providerEntry(providerId: string): ProviderUsageSettings {
    return this.settings.providers?.[providerId] ?? {};
  }

  /** Apply settings immediately, updating the footer and poll schedule in place. */
  setSettings(settings: UsageSettings): void {
    const footerWasOff = this.settings.footerFormat === "off";
    this.settings = { ...settings };
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    void this.renderFooter();
    if (!this.autoNetworkingAllowed()) return;
    if (footerWasOff) void this.refreshActive("session");
    this.schedulePoll();
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
    const auth = await resolveQuotaAuth(session.gateway, providerId, adapter.officialOrigin, adapter.allowedProviderOrigin, adapter.allowedOAuthOrigins);
    if (auth instanceof UsageError) return undefined;
    if (this.fingerprintOf(auth.apiKey) !== entry.fingerprint) return undefined;
    return entry.usage;
  }

  /**
   * Session lifecycle entry point. Resets per-session state (timers, in-flight
   * controller, generation), refreshes the active provider, and starts the
   * configured poll. Idempotent; automatic work is TUI-only and offline-aware.
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
    if (!this.settings.refreshAfterTurn || !this.autoNetworkingAllowed()) return;
    const providerId = this.activeProviderId;
    if (providerId === undefined) return;
    const entry = this.providerEntry(providerId);
    if (entry.disabled || entry.refreshAfterTurn === false) return;
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

  /** Fresh account-bound selection, obtained only after the usage screen closes. */
  async prepareReset(providerId: string): Promise<ResetSelection> {
    const adapter = this.adapterById.get(providerId);
    const session = this.session;
    const generation = this.generation;
    if (!adapter?.fetchResets || !adapter.redeemReset || !session || session.mode !== "tui" || isOffline()) {
      throw new UsageError("unsupported", "Reset redemption is unavailable");
    }
    const usage = await this.refreshProvider(adapter);
    if (usage.error || this.lastError.has(providerId) || this.backoff.has(providerId)) {
      throw new UsageError("request", "Fresh quota is required before reset");
    }
    const auth = await bounded(resolveQuotaAuth(session.gateway, providerId, adapter.officialOrigin,
      adapter.allowedProviderOrigin, adapter.allowedOAuthOrigins), PROVIDER_BOUND_MS);
    if (auth instanceof UsageError) throw auth;
    if (generation !== this.generation || isOffline()) throw new UsageError("canceled", "Session changed; reset canceled");
    const fingerprint = this.fingerprintOf(auth.apiKey);
    if (this.cache.get(providerId)?.fingerprint !== fingerprint) {
      throw new UsageError("auth", "Account changed; reopen /usage");
    }
    const offers = availableResetOffers(usage.resets?.offers ?? [], this.now());
    if (offers.length === 0) throw new UsageError("unsupported", "No redeemable reset is available");
    return { providerId, offers, usage, fingerprint, generation };
  }

  /** One confirmed attempt; recheck account and inventory before any POST. Never retry. */
  async redeemReset(selection: ResetSelection, offerId: string): Promise<string> {
    const { providerId, fingerprint, generation } = selection;
    const adapter = this.adapterById.get(providerId);
    const session = this.session;
    const check = () => {
      if (isOffline() || generation !== this.generation || !session || session.mode !== "tui") {
        throw new UsageError("canceled", "Session changed or offline; reset canceled");
      }
    };
    check();
    if (!adapter?.fetchResets || !adapter.redeemReset || !selection.offers.some((offer) => offer.id === offerId)) {
      throw new UsageError("unsupported", "Reset redemption is unavailable");
    }
    if (this.resetting.has(providerId)) throw new UsageError("canceled", "Reset already in progress");
    const attemptKey = `${providerId}:${fingerprint}:${offerId}`;
    if (this.attemptedResets.has(attemptKey)) throw new UsageError("canceled", "Reset already attempted; verify its outcome with the provider");
    this.resetting.add(providerId);
    let posted = false;
    try {
      await this.inFlight.get(providerId);
      check();
      const auth = await bounded(resolveQuotaAuth(session!.gateway, providerId, adapter.officialOrigin,
        adapter.allowedProviderOrigin, adapter.allowedOAuthOrigins), PROVIDER_BOUND_MS);
      if (auth instanceof UsageError) throw auth;
      check();
      if (this.fingerprintOf(auth.apiKey) !== fingerprint) throw new UsageError("auth", "Account changed; reset canceled");
      const signal = this.ensureController().signal;
      const getJson = this.createRequester(signal);
      const inventory = await bounded(adapter.fetchResets(auth, getJson), PROVIDER_BOUND_MS);
      check();
      const offer = availableResetOffers(inventory.offers, this.now()).find((item) => item.id === offerId);
      if (!offer) throw new UsageError("unsupported", "Selected reset is no longer available");
      const postJson: PostJson = async (url, headers, body) => {
        check();
        const current = await bounded(resolveQuotaAuth(session!.gateway, providerId, adapter.officialOrigin,
          adapter.allowedProviderOrigin, adapter.allowedOAuthOrigins), PROVIDER_BOUND_MS);
        check();
        if (current instanceof UsageError || this.fingerprintOf(current.apiKey) !== fingerprint) {
          throw new UsageError("auth", "Account changed; reset canceled");
        }
        if (offer.expiresAt !== undefined && offer.expiresAt <= this.now()) {
          throw new UsageError("canceled", "Selected reset expired; reset canceled");
        }
        if (posted) throw new UsageError("canceled", "Duplicate reset request refused");
        posted = true;
        this.attemptedResets.add(attemptKey);
        this.cache.delete(providerId);
        return this.createResetRequester(signal)(url, headers, body);
      };
      const message = await adapter.redeemReset(auth, offer, getJson, postJson, randomUUID());
      check();
      return message;
    } catch (error) {
      if (posted) throw new UsageError("request", "Reset outcome may be unknown; check provider usage. No automatic retry was made");
      throw error instanceof UsageError ? error : new UsageError("request", "Reset check failed");
    } finally {
      this.resetting.delete(providerId);
      if (posted && this.generation === generation) {
        this.cache.delete(providerId);
        this.backoff.delete(providerId);
        this.lastError.delete(providerId);
        await this.refreshProvider(adapter);
      }
    }
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
    this.resetNotices.clear();
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.controller?.abort();
    this.controller = undefined;
  }

  private autoNetworkingAllowed(): boolean {
    return this.session !== undefined
      && this.session.mode === "tui"
      && this.settings.footerFormat !== "off"
      && !isOffline();
  }

  private schedulePoll(): void {
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    if (this.settings.pollIntervalMinutes === 0) {
      this.pollTimer = undefined;
      return;
    }
    // unref: the poll must never keep a process (or test run) alive by itself.
    const timer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.pollTick();
    }, this.settings.pollIntervalMinutes * 60_000);
    timer.unref?.();
    this.pollTimer = timer;
  }

  private async pollTick(): Promise<void> {
    try {
      const providerId = this.activeProviderId;
      const entry = providerId !== undefined ? this.providerEntry(providerId) : undefined;
      if (this.autoNetworkingAllowed() && providerId !== undefined && !entry?.disabled && entry?.poll !== false) {
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
    if (this.resetting.has(providerId)) {
      const adapter = this.adapterById.get(providerId)!;
      return Promise.resolve(errorUsage(adapter, new UsageError("canceled", "Reset in progress"), this.now()));
    }
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
    if (this.isReportingDisabled(providerId)) {
      return Promise.resolve(errorUsage(adapter, new UsageError("canceled", "Reporting is disabled for this provider"), this.now()));
    }

    const generation = this.generation;
    const promise = this.runRefresh(adapter, session, generation, trigger);
    this.inFlight.set(providerId, promise);
    return promise.finally(() => {
      if (this.inFlight.get(providerId) === promise) this.inFlight.delete(providerId);
    });
  }

  private async runRefresh(
    adapter: QuotaAdapter,
    session: MonitorSession,
    generation: number,
    trigger: "session" | "model" | "settled" | "poll" | "command",
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
    // Cross-instance slot: claimed (or refused) after auth resolution, before
    // the request; coordination failures never fail or delay the refresh.
    let shared: SharedClaim | undefined;
    const work = async (): Promise<ProviderUsage> => {
      const auth = await resolveQuotaAuth(session.gateway, adapterId, adapter.officialOrigin, adapter.allowedProviderOrigin, adapter.allowedOAuthOrigins);
      if (auth instanceof UsageError) {
        if (this.generation === generation && !callerGaveUp) this.noteFailure(adapterId, undefined);
        return errorUsage(adapter, auth, this.now());
      }
      const fingerprint = this.fingerprintOf(auth.apiKey);
      try {
        shared = this.coordination ? await this.coordination.claim(adapterId, auth.apiKey) : undefined;
      } catch {
        shared = undefined;
      }
      const refusal = this.sharedRefusal(adapterId, shared, trigger);
      if (refusal !== undefined) {
        const cached = await this.serveCached(adapterId);
        await shared?.release();
        if (this.generation === generation && !callerGaveUp) {
          this.lastError.set(adapterId, { kind: "canceled", message: refusal });
          void this.renderFooter();
        }
        return cached !== undefined
          ? cached
          : errorUsage(adapter, new UsageError("canceled", refusal), this.now());
      }
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
        const usage = await attachResets(adapter, auth, getJson, await adapter.fetchQuota(auth, getJson));
        // Awaited so the slot is free before this refresh resolves; release never throws.
        const claim = shared;
        shared = undefined;
        await claim?.release({ lastRefreshAt: usage.capturedAt });
        if (callerGaveUp || this.generation !== generation) return usage; // obsolete
        this.backoff.delete(adapterId);
        this.lastError.delete(adapterId);
        this.cache.set(adapterId, { fingerprint, usage });
        if (adapterId === this.activeProviderId && session.mode === "tui"
          && lowQuotaResetAvailable(usage, this.settings.resetThresholdPercent, this.now())) {
          const noticeKey = `${adapterId}:${fingerprint}`;
          if (!this.resetNotices.has(noticeKey) && session.notify) {
            const shown = session.notify(`${adapter.name}: 5-hour allowance below ${this.settings.resetThresholdPercent}%; reset available. Open /usage`);
            if (shown !== false) this.resetNotices.add(noticeKey);
          }
        }
        void this.renderFooter();
        return usage;
      } catch (error) {
        const usageError = error instanceof UsageError ? error : new UsageError("request", "Provider refresh failed");
        if (this.generation === generation && !callerGaveUp) {
          // Canceled means our own abort (shutdown); no failure to back off from.
          if (usageError.kind !== "canceled") this.noteFailure(adapterId, retryAfterMs);
          const failed = this.backoff.get(adapterId);
          await shared?.release(failed !== undefined
            ? { backoffUntil: failed.until, failures: failed.failures }
            : undefined);
          this.lastError.set(adapterId, { kind: usageError.kind, message: usageError.message });
          void this.renderFooter();
        } else {
          await shared?.release();
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
        const failed = this.backoff.get(adapterId);
        await shared?.release(failed !== undefined
          ? { backoffUntil: failed.until, failures: failed.failures }
          : undefined);
        this.lastError.set(adapterId, { kind: usageError.kind, message: usageError.message });
        void this.renderFooter();
      } else {
        await shared?.release();
      }
      return errorUsage(adapter, usageError, this.now());
    }
  }

  /** Refusal message when shared state or another instance disallows a fetch. */
  private sharedRefusal(
    adapterId: string,
    shared: SharedClaim | undefined,
    trigger: "session" | "model" | "settled" | "poll" | "command",
  ): string | undefined {
    if (shared === undefined || shared.degraded) {
      // Without coordination, mirror only our own state: no refusal here.
      return undefined;
    }
    const now = this.now();
    // Backoff recorded by any running instance is honored by every trigger.
    if (shared.view.backoffUntil !== undefined && shared.view.backoffUntil > now) {
      const back = this.backoff.get(adapterId) ?? { until: 0, failures: 0 };
      if (back.until < shared.view.backoffUntil) {
        back.until = shared.view.backoffUntil;
        if (shared.view.failures !== undefined && shared.view.failures > back.failures) {
          back.failures = shared.view.failures;
        }
        this.backoff.set(adapterId, back);
      }
      return "Refresh deferred: provider backoff active";
    }
    // Another instance is mid-refresh on this account; never double-hit.
    if (!shared.acquired) return "Refresh deferred: another session is refreshing this provider";
    // Auto triggers skip when any instance captured data moments ago; manual
    // and session/model fills always go through.
    const freshWindow = trigger === "settled" || trigger === "poll" ? SHARED_FRESH_MS : 0;
    if (freshWindow > 0 && shared.view.lastRefreshAt !== undefined && now - shared.view.lastRefreshAt < freshWindow) {
      return "Refresh deferred: another session refreshed this provider";
    }
    return undefined;
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
    if (session === undefined || session.mode !== "tui") return;
    if (this.settings.footerFormat === "off" || isOffline()) {
      session.setStatus(STATUS_KEY, undefined);
      return;
    }
    const providerId = this.activeProviderId;
    const adapter = providerId !== undefined ? this.adapterById.get(providerId) : undefined;
    if (adapter === undefined || providerId === undefined || !session.gateway.isConfigured(providerId)
      || this.isReportingDisabled(providerId)) {
      session.setStatus(STATUS_KEY, undefined);
      return;
    }
    const cached = await this.serveCached(providerId);
    if (cached !== undefined) {
      const error = this.lastError.get(providerId);
      session.setStatus(STATUS_KEY, formatFooterText(cached, {
        now: this.now(),
        stale: error !== undefined,
        format: this.settings.footerFormat,
      }));
      return;
    }
    const error = this.lastError.get(providerId);
    if (error !== undefined) {
      const back = this.backoff.get(providerId);
      const retryIn = back !== undefined && back.until > this.now() ? back.until - this.now() : undefined;
      session.setStatus(STATUS_KEY, formatFooterError(error.kind, retryIn, this.settings.footerFormat));
      return;
    }
    // First refresh still in flight: no status yet.
    session.setStatus(STATUS_KEY, undefined);
  }
}
