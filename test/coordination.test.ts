import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSharedCoordination } from "../src/coordination.ts";

const SECRET = "sk-do-not-persist-the-api-key-0123456789";
const freshAgentDir = () => mkdtemp(join(tmpdir(), "pi-usage-coordination-"));
const stateDir = (agentDir: string) => join(agentDir, "pi-usage-state");
const files = async (agentDir: string, suffix: string) =>
  (await readdir(stateDir(agentDir))).filter((name) => name.endsWith(suffix));
/** Instance that refuses immediately instead of waiting for a busy slot. */
const noWait = (agentDir: string) => new FileSharedCoordination(agentDir, { lockWaitMs: 0 });

test("coordination: outcomes are recorded and visible to other instances", async () => {
  const agentDir = await freshAgentDir();
  try {
    const first = await noWait(agentDir).claim("codex", SECRET);
    assert.equal(first.acquired, true);
    assert.equal(first.degraded, false);
    assert.deepEqual(first.view, {}, "a fresh account has no shared timing");
    await first.release({ lastRefreshAt: 1_000 });

    const second = await noWait(agentDir).claim("codex", SECRET);
    assert.equal(second.view.lastRefreshAt, 1_000, "another instance sees the recorded capture time");
    await second.release({ backoffUntil: 5_000, failures: 2 });

    const third = await noWait(agentDir).claim("codex", SECRET);
    assert.equal(third.view.backoffUntil, 5_000);
    assert.equal(third.view.failures, 2);
    assert.equal(third.view.lastRefreshAt, 1_000, "a failure record keeps the last capture time");
    await third.release(); // a plain release rewrites nothing
    assert.equal((await noWait(agentDir).claim("codex", SECRET)).view.backoffUntil, 5_000);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("coordination: artifacts hold timing only, never credentials", async () => {
  const agentDir = await freshAgentDir();
  try {
    const claim = await noWait(agentDir).claim("codex", SECRET);
    await claim.release({ lastRefreshAt: 1 });
    const [stateFile] = await files(agentDir, ".json");
    assert.ok(stateFile);
    for (const name of await readdir(stateDir(agentDir))) {
      assert.equal(name.includes(SECRET), false);
      assert.equal((await readFile(join(stateDir(agentDir), name), "utf8")).includes(SECRET), false);
    }
    assert.deepEqual(Object.keys(JSON.parse(await readFile(join(stateDir(agentDir), stateFile), "utf8"))).sort(),
      ["backoffUntil", "failures", "lastRefreshAt", "version"]);
    assert.ok((await readFile(join(agentDir, "pi-usage-salt"), "utf8")).trim().length >= 32);
    assert.deepEqual(await files(agentDir, ".lock"), [], "lock removed after release");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("coordination: the slot is exclusive until released", async () => {
  const agentDir = await freshAgentDir();
  try {
    const holder = await noWait(agentDir).claim("openrouter", SECRET);
    const refused = await noWait(agentDir).claim("openrouter", SECRET);
    assert.equal(refused.acquired, false);
    await refused.release({ lastRefreshAt: 999 }); // no-op: it never held the slot
    await holder.release({ lastRefreshAt: 42 });
    const next = await noWait(agentDir).claim("openrouter", SECRET);
    assert.equal(next.acquired, true);
    assert.equal(next.view.lastRefreshAt, 42, "a refused claim cannot overwrite the holder's outcome");
    await next.release();
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("coordination: a waiting claim sees the holder's outcome after the lock is read", async () => {
  const agentDir = await freshAgentDir();
  try {
    const holder = await noWait(agentDir).claim("kimi", SECRET);
    const waiter = new FileSharedCoordination(agentDir, { lockWaitMs: 3_000 }).claim("kimi", SECRET);
    setTimeout(() => void holder.release({ lastRefreshAt: 77 }), 400);
    const claim = await waiter;
    assert.equal(claim.acquired, true, "the waiter acquires once the holder releases");
    assert.equal(claim.view.lastRefreshAt, 77, "the view is read after acquisition, not before");
    await claim.release();
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("coordination: a stale lock is taken over and the old owner cannot delete the new lock", async () => {
  const agentDir = await freshAgentDir();
  try {
    const oldOwner = await noWait(agentDir).claim("zai", SECRET);
    const [lockName] = await files(agentDir, ".lock");
    assert.ok(lockName);
    const lockPath = join(stateDir(agentDir), lockName);
    const abandoned = new Date(Date.now() - 300_000);
    await utimes(lockPath, abandoned, abandoned); // simulates a stalled/crashed holder

    const newOwner = await noWait(agentDir).claim("zai", SECRET);
    assert.equal(newOwner.acquired, true, "abandoned lock is taken over");

    await oldOwner.release({ lastRefreshAt: 5 }); // wakes up late
    assert.deepEqual(await files(agentDir, ".lock"), [lockName], "the new owner's lock survives the old owner's release");
    assert.equal((await noWait(agentDir).claim("zai", SECRET)).acquired, false, "slot still held by the new owner");

    await newOwner.release({ lastRefreshAt: 6 });
    assert.deepEqual(await files(agentDir, ".lock"), []);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("coordination: a fresh lock is never taken over", async () => {
  const agentDir = await freshAgentDir();
  try {
    const holder = await noWait(agentDir).claim("grok", SECRET);
    assert.equal((await noWait(agentDir).claim("grok", SECRET)).acquired, false);
    await holder.release();
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("coordination: accounts are isolated from each other", async () => {
  const agentDir = await freshAgentDir();
  try {
    const one = await noWait(agentDir).claim("kimi", "key-one");
    const two = await noWait(agentDir).claim("kimi", "key-two"); // not blocked by account one
    assert.equal(two.acquired, true);
    await one.release({ lastRefreshAt: 7 });
    await two.release();
    assert.deepEqual((await noWait(agentDir).claim("kimi", "key-two")).view, {}, "account two never sees account one's record");
    assert.equal((await files(agentDir, ".json")).length, 1);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("coordination: an unusable agent dir degrades instead of blocking refreshes", async () => {
  const agentDir = await freshAgentDir();
  try {
    const blocker = join(agentDir, "blocker");
    await writeFile(blocker, "a file, not a directory", "utf8");
    const claim = await noWait(join(blocker, "child")).claim("zai", SECRET);
    assert.equal(claim.degraded, true);
    assert.equal(claim.acquired, true, "degraded claims never look refused");
    await claim.release({ lastRefreshAt: 5 });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("coordination: long-idle account state and abandoned locks are pruned", async () => {
  const agentDir = await freshAgentDir();
  try {
    const seed = await noWait(agentDir).claim("codex", "old-account");
    await seed.release({ lastRefreshAt: 1 });
    const [oldState] = await files(agentDir, ".json");
    const ancient = new Date(Date.now() - 30 * 24 * 3_600_000);
    await utimes(join(stateDir(agentDir), oldState!), ancient, ancient);
    await writeFile(join(stateDir(agentDir), "orphan.lock"), "x", "utf8");
    await utimes(join(stateDir(agentDir), "orphan.lock"), ancient, ancient);

    const claim = await noWait(agentDir).claim("codex", "current-account"); // first claim prunes
    await claim.release({ lastRefreshAt: 2 });
    await new Promise((resolve) => setTimeout(resolve, 50)); // pruning is fire-and-forget
    assert.equal((await files(agentDir, ".json")).includes(oldState!), false);
    assert.equal((await files(agentDir, ".lock")).includes("orphan.lock"), false);
    assert.equal((await files(agentDir, ".json")).length, 1, "the active account's state stays");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
