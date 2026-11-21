import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { observeProcess, processIsGone, stopOwnedProcess } from "../../dist/platform-process.js";
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
export async function recoveryScenario({ repo, runner, change, task, timeoutMs, save, summarize }) {
  if (process.platform !== "linux") { save({ status: "BLOCKED", reason: "Exact SIGSTOP-supervisor variant requires Linux" }); return; }
  const [attempt] = runner.launch(change, [task]);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../bin/openspec-runner.js", import.meta.url)), "worker", change, task, "--attempt", attempt.id, "--json"], { cwd: repo, stdio: "ignore" });
  let closed = false, exitCode, exitSignal, paused = false, supervisor = observeProcess(child.pid), launcher;
  const closedPromise = new Promise(resolve => child.once("close", (code, signal) => { closed = true; exitCode = code; exitSignal = signal; resolve(); }));
  const deadline = Date.now() + Math.min(timeoutMs - 10000, 120000);
  const waitFor = async (probe, label) => {
    while (Date.now() < deadline) { const value = probe(); if (value) return value; if (closed && !paused) throw Error(`Supervisor exited before ${label}`); await delay(25); }
    throw Error(`Timed out waiting for ${label}`);
  };
  try {
    const active = await waitFor(() => {
      const a = runner.latest(runner.read(change), task);
      return a.session && a.identityConfirmed && a.worker?.pid === child.pid && a.worker?.launcher?.pid && !a.report ? a : undefined;
    }, "real bound session and independent supervisor");
    supervisor = { pid: active.worker.pid, createdAt: active.worker.processStart };
    launcher = { pid: active.worker.launcher.pid, createdAt: active.worker.launcher.processStart };
    assert.ok(supervisor.createdAt && launcher.createdAt);
    assert.equal(observeProcess(launcher.pid)?.createdAt, launcher.createdAt);
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
    signalOwned(supervisor, "SIGKILL"); paused = false;
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
    else save({ ...evidence, verified: true });
  } finally {
    if (paused && supervisor && observeProcess(supervisor.pid)?.createdAt === supervisor.createdAt) signalOwned(supervisor, "SIGCONT");
    if (supervisor && !processIsGone(supervisor.pid) && observeProcess(supervisor.pid)?.createdAt === supervisor.createdAt) await stopOwnedProcess({ ...supervisor, timeoutMs: 3000 });
    if (launcher && !processIsGone(launcher.pid) && observeProcess(launcher.pid)?.createdAt === launcher.createdAt) await stopOwnedProcess({ ...launcher, timeoutMs: 3000 });
  }
}
