import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedChild, sanitize } from "./model-discovery.mjs";
import { credentialFreeEnvironment, isAuthenticationRejection, plannerScenario, repairScenario, recoveryScenario, validateRecoveryReceipt } from "./lifecycle-scenarios.mjs";
import { fixture, change, task } from "./acceptance-fixture.mjs";
import { Runner } from "../../dist/runner.js";
import { Feature } from "../../dist/feature.js";
import { stopOwnedProcess } from "../../dist/platform-process.js";
import { getHarness } from "../../dist/harnesses/registry.js";
import { git, shellCommand } from "../../dist/system.js";

export function parseLifecycleArgs(args, agent) {
  if (!["claude", "copilot"].includes(agent)) throw Error("Unsupported lifecycle harness");
  const result = { agent, scenario: args[0], timeoutMs: 180000, infer: false, approve: false, cancel: false, retry: false };
  if (!["worker", "archive", "invalid-model", "cancel", "retry", "hooks-disabled", "gates", "auth", "planner", "repair", "recovery", "recovery-abrupt"].includes(result.scenario)) throw Error("Require worker|archive|invalid-model|cancel|retry");
  const seen = new Set();
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key)) throw Error(`Duplicate ${key}`);
    seen.add(key);
    const flag = { "--infer": "infer", "--approve": "approve", "--cancel": "cancel", "--retry": "retry" }[key];
    if (flag) { result[flag] = true; continue; }
    const field = { "--model": "model", "--effort": "effort", "--timeout-ms": "timeoutMs" }[key];
    if (!field || !args[i + 1] || args[i + 1].startsWith("--") || /[\0\r\n]/.test(args[i + 1])) throw Error(`Invalid ${key}`);
    result[field] = args[++i];
  }
  result.timeoutMs = Number(result.timeoutMs);
  if (!result.infer || !result.model?.trim() || !Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 100 || result.timeoutMs > 600000) throw Error("Require --model MODEL --infer and bounded timeout");
  if (result.approve !== (["archive", "repair"].includes(result.scenario)) || result.cancel !== (["cancel", "recovery", "recovery-abrupt"].includes(result.scenario)) || (!["recovery"].includes(result.scenario) && result.retry !== (result.scenario === "retry"))) throw Error("Scenario requires matching explicit --approve, --cancel or --retry opt-in");
  if (result.scenario === "hooks-disabled" && agent !== "copilot") throw Error("Hooks scenario requires Copilot");
  if (["auth", "planner"].includes(result.scenario) && agent !== "claude") throw Error("Scenario requires Claude");
  if (["repair", "recovery", "recovery-abrupt"].includes(result.scenario) && agent !== "copilot") throw Error("Scenario requires Copilot");
  if (agent === "copilot" && result.effort) throw Error("Copilot effort unsupported");
  return result;
}
function argv(options) {
  return [options.scenario, "--model", options.model, "--timeout-ms", String(options.timeoutMs ?? 180000),
    ...["infer", "approve", "cancel", "retry"].filter(k => options[k]).map(k => `--${k}`), ...(options.effort ? ["--effort", options.effort] : [])];
}
export async function runLifecycle(options, dependencies = {}) {
  const validated = parseLifecycleArgs(argv(options), options.agent);
  const root = mkdtempSync(join(dependencies.evidenceRoot ?? tmpdir(), `runner-${validated.agent}-${validated.scenario}-`));
  writeFileSync(join(root, "request.json"), JSON.stringify(validated));
  const invoke = dependencies.invoke ?? boundedChild;
  const result = { root, os: process.platform, agent: validated.agent, scenario: validated.scenario, backend: "git", terminal: "manual", requestedModel: sanitize(validated.model), requestedEffort: validated.effort ?? null, observedEffort: null, status: "FAIL" };
  try {
    const child = await invoke(process.execPath, [fileURLToPath(import.meta.url), "--execute", root], { cwd: root, timeoutMs: validated.timeoutMs });
    result.child = child.evidence;
    const finite = !child.evidence.timedOut && !child.evidence.overflow && !child.evidence.error && child.evidence.remainingBeforeCleanup?.length === 0;
    if (finite && child.evidence.exitCode === 0 && child.evidence.processObservationSupported !== true) {
      result.status = "BLOCKED";
      result.reason = "Owned process observation unavailable or unconfirmed";
    } else if (finite && child.evidence.exitCode === 0) {
      const receipt = JSON.parse(readFileSync(join(root, "receipt.json"), "utf8"));
      if (receipt.scenario === validated.scenario && receipt.verified === false && ["OPEN", "BLOCKED"].includes(receipt.status)) { result.status = receipt.status; result.receipt = receipt; }
      if (receipt.scenario === validated.scenario && receipt.verified === true) { if (["recovery", "recovery-abrupt"].includes(validated.scenario)) validateRecoveryReceipt(receipt, validated); result.status = "PASS"; result.receipt = receipt; }
    }
  } catch (error) { result.error = sanitize(error.message); }
  writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
  return result;
}
export function isModelRejection(text) {
  return /(?:invalid|unknown|unsupported|unrecognized|nonexistent)\s+(?:requested\s+)?model|model[^\r\n]{0,180}(?:does not exist|not found|not (?:available|supported)|invalid|unknown)/i.test(text);
}
function attemptEvidence(a) {
  return { id: a.id, agent: a.agent, phase: a.phase, session: a.session, observedSession: a.observedSession, identityConfirmed: a.identityConfirmed,
    report: a.report ? { outcome: a.report.outcome, commit: a.report.commit } : null, worker: a.worker ? { pid: a.worker.pid, processStart: a.worker.processStart, launcher: a.worker.launcher, startedAt: a.worker.startedAt, exitedAt: a.worker.exitedAt, exitCode: a.worker.exitCode, completion: a.worker.completion, linuxStop: a.worker.linuxStop, linuxIdentity: a.worker.linuxIdentity, linuxNonce: a.worker.linuxNonce, linuxObserved: a.worker.linuxObserved, processPlatform: a.worker.processPlatform } : null, commit: a.report?.commit };
}
async function execute(root) {
  const options = JSON.parse(readFileSync(join(root, "request.json"), "utf8"));
  parseLifecycleArgs(argv(options), options.agent);
  const repo = join(root, "repo");
  mkdirSync(repo);
  fixture(repo, options.scenario === "invalid-model" ? "runner-invalid-model-never-exists" : options.model, options);
  if (options.scenario === "hooks-disabled") {
    rmSync(join(repo, ".github/hooks/openspec-runner.json"));
    git(repo, "add", "."); git(repo, "commit", "-m", "Disable disposable worker hooks");
  }
  const runner = new Runner(repo);
  const attempts = [];
  const version = execFileSync(options.agent, ["--version"], { timeout: 10000, encoding: "utf8" }).match(/\d+\.\d+\.\d+/)?.[0] ?? "unknown";
  const save = extra => writeFileSync(join(root, "receipt.json"), JSON.stringify({ scenario: options.scenario, version, verified: false, attempts, ...extra }, null, 2));
  const role = { harness: options.agent, model: options.model, ...(options.effort ? { effort: options.effort } : {}) };
  if (options.scenario === "auth") {
    const directory = join(root, "empty-claude-config"); mkdirSync(directory);
    const environment = credentialFreeEnvironment(process.env, directory);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, environment);
  }
  if (options.scenario === "planner") { save(await plannerScenario({ repo, common: runner.repo.common, model: options.model, timeoutMs: options.timeoutMs })); return; }
  if (["recovery", "recovery-abrupt"].includes(options.scenario)) { await recoveryScenario({ repo, runner, change, task, timeoutMs: options.timeoutMs, retry: options.retry, abrupt: options.scenario === "recovery-abrupt", save, summarize: attemptEvidence }); return; }
  let feature;
  if (options.approve) {
    feature = new Feature(repo);
    const settings = { implementation: role, review: role, repair: role };
    feature.start(change);
    feature.approve(change, settings, feature.planPreview(change, settings).token);
  }
  const work = async retry => {
    const [attempt] = runner.launch(change, [task], undefined, "HEAD", retry);
    attempts.push(attemptEvidence(attempt)); save();
    let attachment;
    let monitorError;
    let cancellation;
    let reportBeforeExitBlocked = false;
    let cleanupBeforeExitBlocked = false;
    const monitor = setInterval(() => {
      try {
        const active = runner.latest(runner.read(change), task);
        if (options.cancel && !cancellation && active.identityConfirmed && active.session && !active.report) {
          const owned = options.agent === "copilot" ? active.worker?.launcher : { pid: active.worker?.pid, processStart: active.worker?.processStart };
          if (owned?.pid && owned.processStart) cancellation = stopOwnedProcess({ pid: owned.pid, createdAt: owned.processStart, timeoutMs: 3000 });
        }
        if (active.identityConfirmed && active.session && !active.worker?.exitedAt && !active.report) {
          const attached = runner.attach(change, task);
          let invocation = getHarness(options.agent).resumeInvocation(active.settings, active.path, runner.repo.common, active.session);
          invocation = getHarness(options.agent).managedInvocation?.(invocation, { common: runner.repo.common, gitDir: active.gitDir, branch: active.branch }) ?? invocation;
          assert.equal(attached.command, shellCommand([invocation.executable, ...invocation.args]));
          attachment = { attempt: attached.attempt, session: active.session, exactCommandMatched: true };
        }
        if (active.report && !active.worker?.exitedAt) {
          assert.throws(() => runner.integrate(change, [task]));
          reportBeforeExitBlocked = true;
          assert.throws(() => runner.cleanup(change, [task]), /Only integrated tasks can be cleaned/);
          assert.ok(existsSync(active.path));
          cleanupBeforeExitBlocked = true;
        }
      } catch (error) { monitorError = sanitize(error.message); }
    }, 50);
    let result;
    try { result = await runner.worker(change, task, attempt.id); } finally { clearInterval(monitor); }
    save({ attachment, reportBeforeExitBlocked });
    const current = runner.latest(runner.read(change), task);
    attempts[attempts.length - 1] = attemptEvidence(current); save();
    if (cancellation) cancellation = await cancellation;
    if (monitorError) throw Error(monitorError);
    return { result, current, attachment, reportBeforeExitBlocked, cleanupBeforeExitBlocked, cancellation };
  };
  let first;
  try { first = await work(false); } catch (error) {
    if (options.scenario !== "hooks-disabled" || !/^Copilot hooks are missing;/.test(error.message)) throw error;
    assert.ok(attempts.every(a => a.worker === null && a.report === null));
    const state = runner.read(change);
    assert.ok(state && state.attempts.every(a => !a.worker?.pid && !a.worker?.launcher && !a.session && !a.report), "No provider process, session or report may exist after hook rejection");
    attempts.splice(0, attempts.length, ...state.attempts.map(attemptEvidence));
    save({ verified: true, diagnostic: "required-hooks-missing-before-worker", workerStarted: false }); return;
  }
  let { result, current, attachment, reportBeforeExitBlocked, cleanupBeforeExitBlocked, cancellation } = first;
  if (options.cancel || options.scenario === "hooks-disabled") {
    if (options.cancel) assert.deepEqual(cancellation, { stopped: true, uncertain: false }, "Require observed owned process termination");
    assert.equal(current.report, undefined);
    assert.notEqual(current.phase, "completed");
    assert.equal(current.worker?.completion, undefined, "Never fabricate success receipt");
    assert.throws(() => runner.integrate(change, [task]));
    if (options.scenario === "hooks-disabled") assert.match(current.error ?? "", /hooks.*missing|hook.*installation/i);
    save({ verified: true, cancellation, noSuccessfulReceipt: true }); return;
  }
  if (options.scenario === "auth") {
    assert.notEqual(result.exitCode, 0); assert.equal(current.report, undefined);
    assert.ok(isAuthenticationRejection(readFileSync(result.log, "utf8")), "Require explicit authentication rejection, never unrelated failure");
    assert.throws(() => runner.integrate(change, [task]));
    assert.equal(runner.read(change).head, current.base);
    save({ verified: true, diagnostic: "explicit-authentication-rejection", isolatedChildConfig: true }); return;
  }
  if (options.scenario === "gates" && (!reportBeforeExitBlocked || !cleanupBeforeExitBlocked)) {
    save({ status: "OPEN", reason: "Actual accepted-report before supervisor-exit window not observed", reportBeforeExitBlocked, cleanupBeforeExitBlocked }); return;
  }
  if (options.scenario === "invalid-model") {
    assert.notEqual(result.exitCode, 0); assert.equal(current.report, undefined);
    assert.ok(isModelRejection(readFileSync(result.log, "utf8")), "Failure lacks explicit model-rejection diagnostic; not accepted as invalid-model evidence");
    assert.throws(() => runner.integrate(change, [task]));
    save({ verified: true, diagnostic: "explicit-model-rejection" }); return;
  }
  if (options.retry) {
    assert.ok(["failed", "blocked", "stale"].includes(current.phase), "Retry requires observed unsuccessful attempt; no automatic retry after success");
    assert.ok(["failed", "blocked"].includes(current.report?.outcome), "Require real unsuccessful report before explicit retry");
    const firstSession = current.session, firstId = current.id;
    ({ result, current, attachment, reportBeforeExitBlocked } = await work(true));
    assert.notEqual(current.id, firstId);
    assert.equal(runner.read(change).attempts.find(a => a.id === firstId)?.session, firstSession);
  }
  assert.equal(result.exitCode, 0, `Inspect ${result.log}`);
  assert.equal(current.report?.outcome, "completed");
  assert.ok(current.session && current.identityConfirmed);
  assert.ok(current.worker?.exitedAt);
  assert.equal(current.worker?.exitCode, 0);
  const retained = runner.attach(change, task);
  assert.equal(retained.attempt, current.id);
  assert.equal(retained.session, current.session);
  assert.equal(retained.command, undefined, "Finished worker must not auto resume");
  runner.integrate(change, [task]);
  const head = runner.read(change).head;
  if (feature) {
    if (options.scenario === "repair") { await repairScenario({ feature, change, save }); return; }
    const review = feature.launch(change, "review");
    const reviewed = await feature.worker(change, review.id);
    assert.equal(reviewed.exitCode, 0);
    const preview = feature.finalPreview(change);
    feature.approveFinal(change, preview.token);
    const completed = feature.archive(change);
    assert.equal(feature.status(change).phase, "completed");
    save({ verified: true, head, review: review.id, archive: completed.head });
  } else save({ verified: true, head, attachment, reportBeforeExitBlocked, cleanupBeforeExitBlocked, greeting: git(current.path, "show", "HEAD:greeting.txt").trim() });
}
export async function main(args, agent) {
  const result = await runLifecycle(parseLifecycleArgs(args, agent));
  console.log(JSON.stringify({ root: result.root, status: result.status, scenario: result.scenario, exitCode: result.child?.exitCode, timedOut: result.child?.timedOut, receipt: result.receipt, reason: result.reason, error: result.error }, null, 2));
  return result.status === "PASS" ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--execute" || process.argv.length !== 4) throw Error("Internal lifecycle child requires retained request directory");
  try { await execute(resolve(process.argv[3])); } catch (error) {
    const path = join(resolve(process.argv[3]), "failure.json");
    writeFileSync(path, JSON.stringify({ error: sanitize(error.message) }));
    process.exitCode = 1;
  }
}
