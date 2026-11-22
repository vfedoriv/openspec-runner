import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { observeProcess, processIsGone, stopOwnedProcess } from "../../dist/platform-process.js";
import { validateLinuxWorker } from "../../dist/harnesses/lifecycle.js";
import { readHookLease } from "../../dist/harnesses/copilot-hooks.js";
import { randomUUID } from "node:crypto";
import { getHarness } from "../../dist/harnesses/registry.js";
import { gitRaw } from "../../dist/system.js";
import { modelCatalog } from "../../dist/model-catalog.js";
import { boundedChild, sanitize } from "./model-discovery.mjs";

// Construct a new child environment; never inspect or change credential files.
export function credentialFreeEnvironment(environment, directory) {
  const result = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL", "SystemRoot", "COMSPEC"])
    if (typeof environment[key] === "string") result[key] = environment[key];
  return { ...result, CLAUDE_CONFIG_DIR: directory, XDG_CONFIG_HOME: directory };
}
export function isAuthenticationRejection(text) {
  return /not logged in|authentication (?:failed|required)|unauthori[sz]ed|invalid (?:api key|authentication|credentials)|missing (?:an? )?(?:api key|credentials)|please run \/login|\b401\b/i.test(text);
}
export function validatePlannerRows(value, selectors) {
  assert.ok(Array.isArray(value) && value.length === 2, "Require two planning recommendations");
  return ["routine", "complex"].map((kind, index) => {
    const row = value[index];
    assert.equal(row.kind, kind); assert.equal(row.harness, "claude");
    assert.ok(selectors.includes(row.model), "Recommendation must use discovered selector");
    assert.ok(row.effort === null || row.effort === undefined, "Prefer intentional CLI default effort");
    assert.equal(typeof row.rationale, "string");
    assert.match(row.rationale, kind === "routine" ? /H2/ : /H4/);
    assert.match(row.rationale, /default|omit/i);
    // These exact acceptance tasks have no cost/latency/context override.
    // Apply the supplied H2/H4 preferences to discovered aliases/families.
    assert.match(row.model, kind === "routine" ? /sonnet/i : /opus/i);
    assert.match(row.rationale, kind === "routine" ? /routine|boundar|tests|clear/i : /durab|concurr|recover|migration/i);
    return { kind, harness: "claude", model: row.model, effort: null, rationale: sanitize(row.rationale) };
  });
}
export function plannerArguments(invocation) {
  assert.equal(typeof invocation.stdin, "string", "Prompt-only planner requires explicit prompt text");
  return [...invocation.args, "--", invocation.stdin];
}
export async function plannerScenario({ repo, common, model, timeoutMs }) {
  const adapter = getHarness("claude");
  const rules = adapter.planningRules(repo);
  const catalog = await modelCatalog("claude", repo);
  const selectors = catalog.entries.filter(row => row.source === "discovered").map(row => row.selector);
  assert.ok(catalog.status === "available" && selectors.includes(model), "Planner requires a fresh available discovered selector");
  const prompt = `Do not use tools, implement tasks, or write files. Act as openspec-runner-plan for the selected worker harness claude. Read these actual versioned rules and discovered selectors. Recommend settings for (1) routine implementation with clear boundaries and useful tests, (2) complex durable-state concurrency migration with crash recovery. Return ONLY a JSON array in that order with kind routine/complex, harness, model, effort:null, and rationale citing H2/H4 plus why effort intentionally uses the CLI default. Never substitute Codex. Rules: ${JSON.stringify(rules)} Catalog: ${JSON.stringify(selectors)}`;
  const invocation = adapter.initialInvocation({ harness: "claude", model, options: { permissionMode: "dontAsk", allowedTools: [] } }, repo, common, prompt, randomUUID());
  const child = await boundedChild(invocation.executable, plannerArguments(invocation), { cwd: repo, timeoutMs: Math.min(timeoutMs, 90000) });
  assert.equal(child.evidence.exitCode, 0); assert.equal(child.evidence.timedOut, false); assert.equal(child.evidence.overflow, false);
  assert.deepEqual(child.evidence.remainingBeforeCleanup, []);
  const events = child.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const terminal = events.findLast(row => row.type === "result");
  assert.ok(terminal && terminal.is_error !== true);
  const rows = validatePlannerRows(JSON.parse(terminal.result.replace(/^```(?:json)?\s*|\s*```$/g, "")), selectors);
  return { verified: true, rules: rules.documents.map(({ source, version, hash }) => ({ source, version, hash })), catalog: { scope: catalog.scope, fetchedAt: catalog.fetchedAt, selectors }, recommendations: rows,
    planner: { requestedModel: model, observedModel: events.find(row => row.type === "system" && typeof row.model === "string")?.model ?? null, session: terminal.session_id, exitCode: child.evidence.exitCode, effectiveEffort: null } };
}

export function featureJobEvidence(job) {
  return { id: job.id, role: job.role, session: job.session, observedSession: job.observedSession, identityConfirmed: job.identityConfirmed,
    report: job.report ? { outcome: job.report.outcome, head: job.report.head, commit: job.report.commit, findings: job.report.findings?.map(f => ({ id: sanitize(f.id), category: f.category, location: sanitize(f.location), correction: sanitize(f.correction) })) } : null,
    worker: job.worker ? { exitedAt: job.worker.exitedAt, exitCode: job.worker.exitCode, completion: job.worker.completion } : null };
}
export function assertSuccessfulJob(job) {
  assert.equal(job.report?.outcome, "completed");
  assert.ok(job.session && job.identityConfirmed && job.observedSession === job.session);
  assert.ok(job.worker?.exitedAt); assert.equal(job.worker?.exitCode, 0);
  assert.equal(job.worker?.completion?.session, job.session);
  assert.equal(job.worker?.completion?.source, "process-exit");
}
export function assertGreetingPolicyBytes(greeting, policy) {
  assert.equal(greeting, "HELLO\n", "Greeting invariant must survive repair/archive");
  assert.equal(policy, "*.txt text eol=lf\n", "Planted tracked LF policy defect must be fixed exactly");
}
function greetingPolicyAt(repo, head) {
  const greeting = gitRaw(repo, "show", `${head}:greeting.txt`);
  const policy = gitRaw(repo, "show", `${head}:.gitattributes`);
  assertGreetingPolicyBytes(greeting, policy);
  return { head, greeting, policy };
}
export async function repairScenario({ feature, change, save }) {
  const jobs = [];
  const work = async role => {
    const job = feature.launch(change, role);
    jobs.push(featureJobEvidence(job)); save({ jobs });
    const result = await feature.worker(change, job.id);
    assert.equal(result.exitCode, 0);
    const current = feature.read(change).jobs.find(row => row.id === job.id);
    jobs[jobs.length - 1] = featureJobEvidence(current); save({ jobs });
    assertSuccessfulJob(current);
    return current;
  };
  const initial = await work("review");
  assert.ok(initial.report.findings.some(row => ["correctness", "security", "spec", "verification"].includes(row.category) && /gitattributes/.test(row.location + " " + row.correction)), "Require genuine blocking finding for planted LF policy defect");
  assert.throws(() => feature.finalPreview(change), /Blocking/);
  const repaired = await work("repair");
  assert.match(repaired.report.commit ?? "", /^[a-f0-9]{40,64}$/);
  feature.integrate(change, repaired.id);
  const integration = feature.runner.read(change);
  const repairedBytes = greetingPolicyAt(integration.integration.path, integration.head);
  assert.throws(() => feature.finalPreview(change), /fresh review/);
  const fresh = await work("review");
  assert.notEqual(fresh.id, initial.id); assert.notEqual(fresh.session, initial.session);
  assert.notEqual(repaired.session, initial.session); assert.notEqual(repaired.session, fresh.session);
  const preview = feature.finalPreview(change);
  assert.ok(!preview.findings.some(row => ["correctness", "security", "spec", "verification"].includes(row.category)));
  feature.approveFinal(change, preview.token);
  const completed = feature.archive(change);
  assert.equal(feature.status(change).phase, "completed");
  const archivedBytes = greetingPolicyAt(preview.archive.worktree, completed.head);
  save({ verified: true, jobs, repairedBytes, archivedBytes, archive: completed.head, chain: "blocking-review-repair-fresh-review-explicit-approval-archive" });
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function signalOwned(identity, signal) {
  assert.ok(identity && identity.pid !== process.pid && observeProcess(identity.pid)?.createdAt === identity.createdAt, "Signal requires current exact owned identity");
  process.kill(identity.pid, signal);
}
export async function recoveryScenario({ repo, runner, change, task, timeoutMs, retry = false, abrupt = false, save, summarize }) {
  if (process.platform !== "linux") { save({ status: "BLOCKED", reason: "Exact SIGSTOP-supervisor variant requires Linux" }); return; }
  let sentinelChild, sentinel, child, supervisor, launcher, paused = false;
  try {
    sentinelChild = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    sentinel = observeProcess(sentinelChild.pid);
    assert.ok(sentinel);
    const [attempt] = runner.launch(change, [task]);
    child = spawn(process.execPath, [fileURLToPath(new URL("../../bin/openspec-runner.js", import.meta.url)), "worker", change, task, "--attempt", attempt.id, "--json"], { cwd: repo, stdio: "ignore" });
    let closed = false, exitCode, exitSignal;
    supervisor = observeProcess(child.pid);
    const closedPromise = new Promise(resolve => child.once("close", (code, signal) => { closed = true; exitCode = code; exitSignal = signal; resolve(); }));
    const deadline = Date.now() + Math.min(timeoutMs - 10000, 120000);
    const waitFor = async (probe, label) => {
      while (Date.now() < deadline) { const value = probe(); if (value) return value; if (closed && !paused) throw Error(`Supervisor exited before ${label}`); await delay(25); }
      throw Error(`Timed out waiting for ${label}`);
    };
    const active = await waitFor(() => {
      const a = runner.latest(runner.read(change), task);
      return a.session && a.identityConfirmed && a.worker?.pid === child.pid && a.worker?.launcher?.pid && !a.report ? a : undefined;
    }, "real bound session and independent supervisor");
    supervisor = { pid: active.worker.pid, createdAt: active.worker.processStart };
    launcher = { pid: active.worker.launcher.pid, createdAt: active.worker.launcher.processStart };
    assert.ok(supervisor.createdAt && launcher.createdAt);
    assert.equal(observeProcess(launcher.pid)?.createdAt, launcher.createdAt);
    if (abrupt) {
      assert.equal(readHookLease(runner.repo.stateDir, attempt.id)?.stoppedAt, undefined);
      assert.equal(runner.latest(runner.read(change), task).report, undefined);
      signalOwned(supervisor, "SIGKILL");
      await Promise.race([closedPromise, delay(3000)]); assert.ok(closed);
      assert.equal(exitSignal, "SIGKILL");
      try { await runner.worker(change, task, attempt.id); } catch {}
      assert.throws(() => runner.preview(change, [task], undefined, "HEAD", true));
      const failed = runner.latest(runner.read(change), task);
      assert.equal(failed.phase, "failed"); assert.equal(failed.worker.exitCode, null);
      assert.equal(failed.report, undefined); assert.equal(failed.worker.completion, undefined);
      save({ status: "BLOCKED", processObservationSupported: true, supervisorSignal: exitSignal, supervisorExitCode: exitCode, sentinelSurvived: observeProcess(sentinel.pid)?.createdAt === sentinel.createdAt, variant: "SIGKILL-supervisor-before-root-stop", failClosed: true, retryBlocked: true, readiness: { supervisor, launcher, session: active.session, rootStopAbsent: true, reportAbsent: true }, attempts: [summarize(failed)], reason: "Unprepared abrupt loss remains blocked; no late report or recovery proof fabricated" });
      return;
    }
    let pausedAt;
    for (let retries = 0; retries < 10 && !paused; retries++) {
      if (existsSync(join(runner.repo.stateDir, "lock.json"))) { await delay(25); continue; }
      assert.equal(readHookLease(runner.repo.stateDir, attempt.id)?.stoppedAt, undefined, "Must interrupt before real root stop");
      signalOwned(supervisor, "SIGSTOP"); pausedAt = new Date().toISOString(); await delay(20);
      const lock = join(runner.repo.stateDir, "lock.json");
      if (existsSync(lock) && JSON.parse(readFileSync(lock, "utf8")).pid === supervisor.pid) {
        // Resume the exact owned supervisor; never remove or clear a lock.
        signalOwned(supervisor, "SIGCONT"); await delay(25);
      } else paused = true;
    }
    assert.ok(paused, "Could not suspend supervisor outside its critical section");
    save({ variant: "SIGSTOP-supervisor-before-root-stop-then-SIGKILL", supervisor, launcher, pausedAt, attempts: [summarize(runner.latest(runner.read(change), task))] });
    const stopped = await waitFor(() => {
      const lease = readHookLease(runner.repo.stateDir, attempt.id);
      return lease?.session === active.session && lease.reportAccepted && lease.stoppedAt ? lease : undefined;
    }, "genuine late accepted report and matching root stop");
    const late = runner.latest(runner.read(change), task);
    assert.equal(late.report?.outcome, "completed"); assert.equal(late.worker.exitedAt, undefined);
    assert.ok(Date.parse(stopped.stoppedAt) >= Date.parse(pausedAt));
    assert.throws(() => runner.integrate(change, [task]));
    assert.throws(() => runner.cleanup(change, [task]));
    runner.prepareCopilotStop(change, task, attempt.id, { cancel: true, timeoutMs: 10000 }); paused = false;
    await Promise.race([closedPromise, delay(3000)]); assert.ok(closed);
    assert.equal(exitSignal, "SIGKILL");
    const goneDeadline = Date.now() + 5000;
    while (!processIsGone(launcher.pid) && Date.now() < goneDeadline) await delay(25);
    assert.ok(processIsGone(launcher.pid), "Matching root stop alone does not prove launcher exited");
    await runner.worker(change, task, attempt.id);
    const recovered = runner.latest(runner.read(change), task);
    assert.equal(recovered.phase, "failed"); assert.equal(recovered.worker.exitCode, null);
    assert.equal(recovered.worker.completion, undefined); assert.throws(() => runner.integrate(change, [task]));
    let retryBlocked = false;
    try { runner.preview(change, [task], undefined, "HEAD", true); } catch (error) { assert.match(error.message, /worker.*stopped|termination|active/i); retryBlocked = true; }
    const evidence = { variant: "SIGSTOP-supervisor-before-root-stop-then-SIGKILL", supervisor, launcher, pausedAt, rootStoppedAt: stopped.stoppedAt, rootSession: stopped.session,
      acceptedLateReport: true, noSuccessfulReceipt: true, supervisorSignal: exitSignal, supervisorExitCode: exitCode, launcherObservedGone: true, retryBlocked, attempts: [summarize(recovered)] };
    if (retryBlocked) save({ ...evidence, status: "BLOCKED", reason: "Linux stale-launcher recovery intentionally retains ownership; explicit retry remains blocked. No state or lock was bypassed." });
    else {
      assert.ok(recovered.worker.linuxStop);
      assert.ok(processIsGone(supervisor.pid));
      const attempts = [summarize(recovered)];
      let integration, freshRootStop;
      if (retry) {
        const [replacement] = runner.launch(change, [task], undefined, "HEAD", true);
        const result = await runner.worker(change, task, replacement.id);
        assert.equal(result.exitCode, 0);
        const completed = runner.latest(runner.read(change), task);
        assert.notEqual(completed.id, recovered.id); assert.notEqual(completed.session, recovered.session);
        assertSuccessfulJob(completed);
        assert.equal(readHookLease(runner.repo.stateDir, completed.id)?.session, completed.session);
        freshRootStop = readHookLease(runner.repo.stateDir, completed.id);
        assert.ok(freshRootStop?.stoppedAt);
        assert.notEqual(completed.report.commit, recovered.report.commit);
        runner.integrate(change, [task]); integration = runner.read(change).head;
        assert.equal(runner.read(change).attempts.find(a => a.id === recovered.id).phase, "failed");
        attempts.push(summarize(completed));
      }
      save({ ...evidence, verified: true, proof: recovered.worker.linuxStop, allObservedGone: recovered.worker.linuxStop.receipt.members.every(m => processIsGone(m.pid)), supervisorObservedGone: true, integration, freshRootStop: freshRootStop ? { session: freshRootStop.session, stoppedAt: freshRootStop.stoppedAt, reportAccepted: freshRootStop.reportAccepted } : undefined, sentinelSurvived: observeProcess(sentinel.pid)?.createdAt === sentinel.createdAt, attempts });
    }
  } catch (error) {
    if (/Timed out waiting|Supervisor exited before|Could not suspend|Incomplete Linux|Linux cancellation|Linux process|Python.*pidfd/.test(error.message)) save({ status: "BLOCKED", reason: sanitize(error.message), variant: abrupt ? "SIGKILL-supervisor-before-root-stop" : "SIGSTOP-supervisor-before-root-stop-then-SIGKILL" });
    else throw error;
  } finally {
    const sentinelSurvived = !sentinel || observeProcess(sentinel.pid)?.createdAt === sentinel.createdAt;
    if (sentinel) {
      await stopOwnedProcess({ ...sentinel, timeoutMs: 3000 });
    } else sentinelChild?.kill("SIGKILL");
    if (paused && supervisor && observeProcess(supervisor.pid)?.createdAt === supervisor.createdAt) signalOwned(supervisor, "SIGCONT");
    if (supervisor && !processIsGone(supervisor.pid) && observeProcess(supervisor.pid)?.createdAt === supervisor.createdAt) await stopOwnedProcess({ ...supervisor, timeoutMs: 3000 });
    if (launcher && !processIsGone(launcher.pid) && observeProcess(launcher.pid)?.createdAt === launcher.createdAt) await stopOwnedProcess({ ...launcher, timeoutMs: 3000 });
    assert.ok(sentinelSurvived, "Unrelated sentinel must survive");
  }
}

export function validateRecoveryReceipt(receipt, options) {
  assert.equal(options.scenario, "recovery", "Abrupt unprepared loss cannot claim end-to-end recovery");
  assert.equal(receipt.variant, "SIGSTOP-supervisor-before-root-stop-then-SIGKILL");
  assert.equal(receipt.acceptedLateReport, true);
  assert.equal(receipt.supervisorSignal, "SIGKILL");
  assert.equal(receipt.supervisorExitCode, null);
  assert.equal(receipt.supervisorObservedGone, true); assert.equal(receipt.launcherObservedGone, true);
  assert.equal(receipt.allObservedGone, true);
  assert.equal(receipt.sentinelSurvived, true);
  assert.equal(receipt.retryBlocked, false); assert.equal(receipt.noSuccessfulReceipt, true);
  const old = receipt.attempts?.[0], proof = receipt.proof;
  assert.equal(old?.phase, "failed"); assert.equal(old.worker.exitCode, null); assert.equal(old.worker.completion, undefined);
  assert.equal(old.report.outcome, "completed"); assert.ok(old.id && old.session);
  assert.equal(old.identityConfirmed, true); assert.equal(old.observedSession, old.session);
  assert.equal(old.session, receipt.rootSession);
  assert.ok(old.worker.exitedAt); assert.ok(old.worker.launcher?.exitedAt);
  assert.equal(old.worker.launcher.exitCode, null);
  assert.ok(old.worker.linuxNonce && old.worker.linuxObserved?.length);
  for (const digest of [proof?.binding, proof?.integrity]) assert.match(digest ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(old.worker.linuxStop, proof);
  validateLinuxWorker(old.worker);
  assert.equal(proof.version, 1); assert.equal(proof.receipt.version, 1);
  assert.ok(proof.receipt.provenance);
  assert.equal(proof.receipt.roots.length, 2);
  for (const identity of [receipt.supervisor, receipt.launcher]) {
    assert.ok(proof.receipt.roots.some(r => r.pid === identity.pid && r.createdAt === identity.createdAt));
    assert.ok(proof.receipt.members.some(r => r.pid === identity.pid && r.createdAt === identity.createdAt));
  }
  if (options.retry) {
    assert.equal(receipt.attempts.length, 2);
    const fresh = receipt.attempts[1]; assert.ok(fresh);
    assert.notEqual(fresh.id, old.id); assert.notEqual(fresh.session, old.session);
    assert.equal(receipt.freshRootStop?.session, fresh.session); assert.ok(receipt.freshRootStop?.stoppedAt); assert.ok(receipt.freshRootStop?.reportAccepted);
    assertSuccessfulJob(fresh); assert.notEqual(fresh.report.commit, old.report.commit);
    assert.ok(fresh.worker.completion.at);
    assert.notDeepEqual([fresh.worker.pid, fresh.worker.processStart], [old.worker.pid, old.worker.processStart]);
    assert.notDeepEqual([fresh.worker.launcher?.pid, fresh.worker.launcher?.processStart], [old.worker.launcher.pid, old.worker.launcher.processStart]);
    assert.match(receipt.integration ?? "", /^[a-f0-9]{40,64}$/);
  } else assert.equal(receipt.attempts.length, 1);
}
