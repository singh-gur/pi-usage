/**
 * Cross-process coordination for quota refreshes (multiple running Pi
 * instances sharing one provider account).
 *
 * Shares only timing/backoff state: per provider + account, the last
 * successful refresh time and the failure backoff most recently negotiated.
 * No usage data is ever persisted and file names/keys carry only a
 * persistent-salted credential fingerprint hash, so the in-memory cache and
 * its account-boundary invariants are unchanged.
 *
 * Each account has its own state file plus an advisory lock file in
 * `pi-usage-state/`. The lock (exclusive create, staleness-checked so a
 * crashed instance cannot wedge it) is held across the whole refresh; the
 * state is read after the lock is acquired and written before it is released,
 * so same-account writers never race and different accounts never share a file.
 * Coordination failures degrade to per-instance behavior and never block or
 * fail a refresh.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SALT_FILENAME = "pi-usage-salt";
const STATE_DIRNAME = "pi-usage-state";
/** A lock older than this (refreshes are bounded to 30s) is abandoned. */
const LOCK_STALE_MS = 45_000;
/** Account state untouched for this long is pruned. */
const STATE_TTL_MS = 7 * 24 * 3_600_000;
const LOCK_POLL_MS = 250;
/** How long a claim waits for another instance's in-flight refresh. */
const DEFAULT_LOCK_WAIT_MS = 8_000;

/** Timing state shared across instances for one provider account. */
export interface SharedView {
  lastRefreshAt?: number | undefined;
  backoffUntil?: number | undefined;
  failures?: number | undefined;
}

/** Outcome reported by the monitor after the refresh completes or is refused. */
export interface SharedOutcome {
  /** Success capture time (epoch ms) when the refresh succeeded. */
  lastRefreshAt?: number;
  /** Backoff expiry (epoch ms) when the refresh failed. */
  backoffUntil?: number;
  failures?: number;
}

/**
 * A claimed refresh slot. `acquired` is false when another instance still
 * holds the slot after the bounded wait (callers treat it as a refusal).
 * `degraded` is true when coordination itself failed (missing/unusable agent
 * dir); callers then proceed without sharing. `release` is always safe (a
 * no-op when the slot was not acquired, or on any underlying failure).
 */
export interface SharedClaim {
  view: SharedView;
  acquired: boolean;
  degraded: boolean;
  release(outcome?: SharedOutcome): Promise<void>;
}

export interface SharedCoordination {
  claim(providerId: string, apiKey: string): Promise<SharedClaim>;
}

export interface FileCoordinationOptions {
  /** Max wait for another instance's in-flight refresh; 0 refuses immediately. */
  lockWaitMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * File-backed cross-instance coordination, one agent dir per installation.
 * Test code passes a temporary directory; production reads Pi's agent dir.
 */
export class FileSharedCoordination implements SharedCoordination {
  private readonly agentDir: string;
  private readonly lockWaitMs: number;
  private salt: string | undefined;
  private pruned = false;

  constructor(agentDir: string = getAgentDir(), options: FileCoordinationOptions = {}) {
    this.agentDir = agentDir;
    this.lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  }

  claim = async (providerId: string, apiKey: string): Promise<SharedClaim> => {
    let base: string;
    try {
      const fingerprint = await this.fingerprintOf(apiKey);
      const dir = join(this.agentDir, STATE_DIRNAME);
      await mkdir(dir, { recursive: true });
      base = join(dir, `${providerId.replace(/[^a-z0-9-]/gi, "_")}-${sha256(fingerprint).slice(0, 32)}`);
    } catch {
      // Coordination unavailable (agent dir missing/unusable): never block a refresh.
      return { view: {}, acquired: true, degraded: true, release: async () => {} };
    }
    const statePath = `${base}.json`;
    const lockPath = `${base}.lock`;
    void this.pruneOnce(join(this.agentDir, STATE_DIRNAME));

    // Unique ownership token: release only removes a lock that is still ours.
    const token = randomBytes(16).toString("hex");
    const acquired = await this.acquireWithWait(lockPath, token);
    // Read only after the lock decision so a waiter sees the holder's outcome.
    const view = await this.readView(statePath);
    if (!acquired) return { view, acquired: false, degraded: false, release: async () => {} };

    let released = false;
    const release = async (outcome?: SharedOutcome): Promise<void> => {
      if (released) return;
      released = true;
      try {
        // Record first, unlock second: the next claimant must see this outcome.
        if (outcome && (outcome.lastRefreshAt !== undefined || outcome.backoffUntil !== undefined)) {
          await this.writeState(statePath, view, outcome);
        }
      } catch {
        // Best effort: a lost record only costs one redundant refresh.
      } finally {
        // After a stall past the stale window another instance may own the lock now.
        // shortcut: read-then-rm is not atomic; the residual window is microseconds, upgrade to OS-level locks if ever observed.
        if (await readFile(lockPath, "utf8").catch(() => undefined) === token) {
          await rm(lockPath, { force: true }).catch(() => {});
        }
      }
    };
    return { view, acquired: true, degraded: false, release };
  };

  /** Persistent-salted credential fingerprint: stable per machine, never raw. */
  private async fingerprintOf(apiKey: string): Promise<string> {
    if (this.salt === undefined) {
      const saltPath = join(this.agentDir, SALT_FILENAME);
      await mkdir(this.agentDir, { recursive: true });
      try {
        const existing = (await readFile(saltPath, "utf8")).trim();
        if (existing === "") throw new Error("empty salt file");
        this.salt = existing;
      } catch {
        const value = randomBytes(32).toString("hex");
        // wx: if another instance won the race this throws and the claim
        // degrades once; the next claim reads the winner's salt.
        const handle = await open(saltPath, "wx", 0o600);
        try {
          await handle.writeFile(value, "utf8");
          this.salt = value;
        } finally {
          await handle.close();
        }
      }
    }
    return createHash("sha256").update(this.salt).update(apiKey).digest("hex");
  }

  private async readView(statePath: string): Promise<SharedView> {
    try {
      const parsed: unknown = JSON.parse(await readFile(statePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return {};
      const raw = parsed as Record<string, unknown>;
      const finite = (name: string): number | undefined =>
        typeof raw[name] === "number" && Number.isFinite(raw[name]) ? (raw[name] as number) : undefined;
      return { lastRefreshAt: finite("lastRefreshAt"), backoffUntil: finite("backoffUntil"), failures: finite("failures") };
    } catch {
      return {};
    }
  }

  private async writeState(statePath: string, previous: SharedView, outcome: SharedOutcome): Promise<void> {
    const state = {
      version: 1,
      lastRefreshAt: outcome.lastRefreshAt ?? previous.lastRefreshAt,
      backoffUntil: outcome.backoffUntil ?? 0,
      failures: outcome.failures ?? 0,
    };
    const temporary = `${statePath}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, statePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  /** One acquisition attempt, then bounded polling while another instance holds the slot. */
  private async acquireWithWait(lockPath: string, token: string): Promise<boolean> {
    const deadline = Date.now() + this.lockWaitMs;
    for (;;) {
      if (await tryCreateLock(lockPath, token)) return true;
      if (Date.now() + LOCK_POLL_MS > deadline) return false;
      await sleep(LOCK_POLL_MS);
    }
  }

  /** Best-effort, once per instance: drop long-idle account files and abandoned locks. */
  private async pruneOnce(dir: string): Promise<void> {
    if (this.pruned) return;
    this.pruned = true;
    try {
      const now = Date.now();
      for (const name of await readdir(dir)) {
        const path = join(dir, name);
        const age = now - (await stat(path)).mtimeMs;
        if ((name.endsWith(".json") && age > STATE_TTL_MS) || (name.endsWith(".lock") && age > LOCK_STALE_MS)) {
          await rm(path, { force: true });
        }
      }
    } catch {
      // Pruning is housekeeping only.
    }
  }
}

/**
 * Exclusive create of a lock whose content is the owner's token. An existing
 * lock is taken over only if it is stale AND unchanged when re-read right
 * before removal, so a lock another waiter just took over is left alone.
 */
async function tryCreateLock(lockPath: string, token: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(token, "utf8");
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      try {
        const seen = await readFile(lockPath, "utf8");
        if (Date.now() - (await stat(lockPath)).mtimeMs < LOCK_STALE_MS) return false;
        if (await readFile(lockPath, "utf8") !== seen) return false; // replaced meanwhile
        // shortcut: stat/read/rm is not atomic; a takeover race needs a crashed holder plus simultaneous waiters and costs one duplicate request.
        await rm(lockPath, { force: true });
      } catch (inner) {
        // Released or pruned between EEXIST and the read: just try to create again.
        if ((inner as NodeJS.ErrnoException).code === "ENOENT") continue;
        return false;
      }
    }
  }
  return false;
}
