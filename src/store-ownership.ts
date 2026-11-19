import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import type { ExecutionContext } from "./execution-context.js";
import { readComponentBinding } from "./component-state.js";
import { unredirectedStorePath } from "./planning-source.js";
import { attempt, git } from "./system.js";

const ownerPrefix = "refs/openspec-runner/store-owners/";
function marker(context: ExecutionContext) {
  if (!context.store) throw new Error("Store ownership requires an explicit execution scope");
  return createHash("sha256").update(context.store.storeRoot).digest("hex");
}
function currentOwner(context: ExecutionContext) {
  const refs = git(context.implementation.root, "for-each-ref", "--format=%(refname)", ownerPrefix).split("\n").filter(Boolean);
  if (refs.length > 1 || refs.some(ref => !/^[a-f0-9]{64}$/.test(ref.slice(ownerPrefix.length))))
    throw new Error("Ambiguous code clone Store ownership; inspect its Git references");
  return refs[0]?.slice(ownerPrefix.length);
}
/** The ref points to existing code; its name stores only an opaque owner hash. */
export function assertStoreOwnership(context: ExecutionContext) {
  if (currentOwner(context) !== marker(context)) throw new Error("Code clone ownership belongs to another Store or requires recovery");
}
function ownershipLock<T>(context: ExecutionContext, action: () => T): T {
  const lock = unredirectedStorePath(context.implementation.common, "refs", "openspec-runner", "store-ownership.lock");
  mkdirSync(dirname(lock), { recursive: true });
  const token = JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() });
  const deadline = Date.now() + 3000;
  for (;;) {
    try { writeFileSync(lock, token, { flag: "wx" }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = attempt(() => JSON.parse(readFileSync(lock, "utf8")));
      if (Date.now() >= deadline || owner?.host !== hostname() || owner.pid === process.pid ||
          !Number.isSafeInteger(owner.pid) || !attempt(() => { process.kill(owner.pid, 0); return true; }))
        throw new Error("Code clone Store ownership is locked; inspect its existing owner before recovery");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return action(); }
  finally { if (attempt(() => readFileSync(lock, "utf8")) === token) unlinkSync(lock); }
}
function hasActiveBinding(context: ExecutionContext) {
  const root = unredirectedStorePath(context.store!.storeRoot, ".openspec-runner");
  if (!existsSync(root)) return false;
  for (const owner of readdirSync(root)) {
    if (!/^[a-f0-9]{64}$/.test(owner)) continue;
    const stateDir = unredirectedStorePath(root, owner, "runtime"), bindings = unredirectedStorePath(stateDir, "components");
    if (!existsSync(bindings)) continue;
    for (const file of readdirSync(bindings)) {
      if (!file.endsWith(".json")) continue;
      const binding = readComponentBinding({ stateDir, change: file.slice(0, -5) });
      if (!binding || binding.assignment.version !== 2 || binding.phase === "retired") continue;
      const expected = createHash("sha256").update(JSON.stringify([binding.featureId, binding.assignment.componentId, context.implementation.common])).digest("hex");
      if (owner === expected) return true;
    }
  }
  return false;
}
/** Serialize lease acquisition with publishing a Store-owned reservation. No code checkout files change. */
export function withStoreOwnership<T>(context: ExecutionContext, base: string, publish: () => T): T {
  return ownershipLock(context, () => {
    const existing = currentOwner(context), expected = marker(context);
    if (existing && existing !== expected) throw new Error("Code clone ownership belongs to another Store; retire its assignments first");
    const ownerRef = `${ownerPrefix}${expected}`;
    if (!existing) git(context.implementation.root, "update-ref", ownerRef, base, "0".repeat(base.length));
    try { return publish(); }
    catch (error) {
      if (!existing && !hasActiveBinding(context)) git(context.implementation.root, "update-ref", "-d", ownerRef, base);
      throw error;
    }
  });
}
/** Retirement releases the lease only when every scope for this code clone is retired. */
export function releaseStoreOwnership(context: ExecutionContext) {
  ownershipLock(context, () => {
    assertStoreOwnership(context);
    if (!hasActiveBinding(context)) {
      const ownerRef = `${ownerPrefix}${marker(context)}`;
      const head = git(context.implementation.root, "rev-parse", ownerRef);
      git(context.implementation.root, "update-ref", "-d", ownerRef, head);
    }
  });
}
