import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("lifecycle scenarios validate before creating evidence or invoking children", async () => {
  const { parseLifecycleArgs, runLifecycle } = await import("./live/lifecycle-acceptance.mjs");
  const root = mkdtempSync(join(tmpdir(), "lifecycle-test-"));
  let calls = 0;
  for (const args of [[], ["worker", "--model", "sonnet"], ["archive", "--model", "sonnet", "--infer"], ["cancel", "--model", "sonnet", "--infer"], ["worker", "--model", "sonnet", "--infer", "--retry"], ["worker", "--model", "sonnet", "--infer", "--approve"]]) {
    assert.throws(() => parseLifecycleArgs(args, "claude"));
  }
  await assert.rejects(runLifecycle({ agent: "claude", scenario: "worker", model: "sonnet" }, { evidenceRoot: root, invoke: () => calls++ }));
  assert.equal(calls, 0);
  assert.deepEqual(readdirSync(root), []);
  assert.equal(parseLifecycleArgs(["archive", "--model", "sonnet", "--infer", "--approve"], "claude").approve, true);
  assert.equal(parseLifecycleArgs(["cancel", "--model", "auto", "--infer", "--cancel"], "copilot").cancel, true);
});

test("failed lifecycle retains bounded child evidence without retrying", async () => {
  const { runLifecycle } = await import("./live/lifecycle-acceptance.mjs");
  const root = mkdtempSync(join(tmpdir(), "lifecycle-test-"));
  let calls = 0;
  const result = await runLifecycle({ agent: "claude", scenario: "worker", model: "sonnet", infer: true, timeoutMs: 100 }, {
    evidenceRoot: root,
    invoke: async () => { calls++; return { stdout: "secret=PRIVATE", evidence: { exitCode: 7, timedOut: false, remainingBeforeCleanup: [] } }; },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "FAIL");
  assert.equal(result.child.exitCode, 7);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(JSON.parse(readFileSync(join(result.root, "result.json"))).status, "FAIL");
});

test("timeout and unobserved requested cancellation cannot pass", async () => {
  const { runLifecycle } = await import("./live/lifecycle-acceptance.mjs");
  for (const evidence of [{ exitCode: 0, timedOut: true }, { exitCode: 0, timedOut: false, interrupted: false }]) {
    const result = await runLifecycle({ agent: "copilot", scenario: "cancel", model: "auto", infer: true, cancel: true, timeoutMs: 100 }, {
      invoke: async () => ({ stdout: "", evidence: { ...evidence, remainingBeforeCleanup: [], processObservationSupported: true } }),
    });
    assert.equal(result.status, "FAIL");
  }
});

test("shared real fixture initializes explicit Copilot model without Codex configuration", async () => {
  const { fixture } = await import("./live/acceptance-fixture.mjs");
  const root = mkdtempSync(join(tmpdir(), "lifecycle-fixture-"));
  fixture(root, "auto", { agent: "copilot" });
  const config = JSON.parse(readFileSync(join(root, "openspec/runner.yaml"), "utf8"));
  assert.equal(config.defaultAgent, "copilot");
  assert.equal(config.agents.copilot.defaultModel, "auto");
  assert.equal(config.agents.codex, undefined);
});

test("invalid-model acceptance requires model rejection rather than unrelated startup failure", async () => {
  const { isModelRejection } = await import("./live/lifecycle-acceptance.mjs");
  assert.equal(isModelRejection("Authentication failed: unauthorized 401"), false);
  assert.equal(isModelRejection("spawn claude ENOENT"), false);
  assert.equal(isModelRejection("unknown model runner-invalid-model-never-exists"), true);
  assert.equal(isModelRejection("The model runner-invalid-model-never-exists does not exist"), true);
});

test("hooks-disabled scenario accepts exact early launch rejection without any worker", async () => {
  const { runLifecycle } = await import("./live/lifecycle-acceptance.mjs");
  const result = await runLifecycle({ agent: "copilot", scenario: "hooks-disabled", model: "auto", infer: true, timeoutMs: 30000 });
  assert.equal(result.status, "PASS");
  assert.equal(result.receipt.diagnostic, "required-hooks-missing-before-worker");
  assert.equal(result.receipt.attempts.length, 1);
  assert.equal(result.receipt.attempts[0].worker.pid, undefined);
  assert.equal(result.receipt.attempts[0].worker.launcher, undefined);
  assert.equal(result.receipt.attempts[0].worker.exitCode, null);
  assert.equal(result.receipt.attempts[0].report, null);
  assert.equal(result.receipt.workerStarted, false);
});

test("extension scenarios require matching explicit approval and interruption opt-ins", async () => {
  const { parseLifecycleArgs } = await import("./live/lifecycle-acceptance.mjs");
  for (const scenario of ["gates", "auth", "planner"]) assert.equal(parseLifecycleArgs([scenario, "--model", "sonnet", "--infer"], "claude").scenario, scenario);
  assert.throws(() => parseLifecycleArgs(["repair", "--model", "auto", "--infer"], "copilot"));
  assert.equal(parseLifecycleArgs(["repair", "--model", "auto", "--infer", "--approve"], "copilot").approve, true);
  assert.throws(() => parseLifecycleArgs(["recovery", "--model", "auto", "--infer"], "copilot"));
  assert.equal(parseLifecycleArgs(["recovery", "--model", "auto", "--infer", "--cancel"], "copilot").cancel, true);
});

test("credential-free child environment never mutates parent or forwards credential/provider fields", async () => {
  const { credentialFreeEnvironment, isAuthenticationRejection } = await import("./live/lifecycle-scenarios.mjs");
  const env = { PATH: "/bin", HOME: "/original", ANTHROPIC_API_KEY: "PRIVATE", CLAUDE_CODE_OAUTH_TOKEN: "PRIVATE", CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "private", ANTHROPIC_BASE_URL: "private" };
  const child = credentialFreeEnvironment(env, "/tmp/empty-config");
  assert.equal(child.PATH, "/bin"); assert.equal(child.CLAUDE_CONFIG_DIR, "/tmp/empty-config");
  for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "AWS_PROFILE", "ANTHROPIC_BASE_URL"]) assert.equal(child[key], undefined);
  assert.equal(env.ANTHROPIC_API_KEY, "PRIVATE");
  assert.equal(isAuthenticationRejection("Invalid model"), false);
  assert.equal(isAuthenticationRejection("Not logged in · Please run /login"), true);
});

test("missed lifecycle gates remain inconclusive, never a generic worker pass", async () => {
  const { runLifecycle } = await import("./live/lifecycle-acceptance.mjs");
  const { writeFileSync } = await import("node:fs");
  const result = await runLifecycle({ agent: "claude", scenario: "gates", model: "sonnet", infer: true }, { invoke: async (_, args) => {
    writeFileSync(join(args[2], "receipt.json"), JSON.stringify({ scenario: "gates", verified: false, status: "OPEN", reason: "Report-before-exit window not observed" }));
    return { stdout: "", evidence: { exitCode: 0, remainingBeforeCleanup: [], processObservationSupported: true } };
  } });
  assert.equal(result.status, "OPEN");
});

test("planner rejects unsupported selectors, Codex substitution, and invented effort", async () => {
  const { validatePlannerRows } = await import("./live/lifecycle-scenarios.mjs");
  const rows = [{ kind: "routine", harness: "claude", model: "sonnet", effort: null, rationale: "H2 routine task; omit effort for CLI default" }, { kind: "complex", harness: "claude", model: "opus", effort: null, rationale: "H4 concurrency; omit effort for CLI default" }];
  assert.equal(validatePlannerRows(rows, ["sonnet", "opus"]).length, 2);
  for (const edit of [r => r[0].model = "missing", r => r[0].harness = "codex", r => r[1].effort = "high", r => r[1].rationale = "No rule cited"]) {
    const bad = structuredClone(rows); edit(bad); assert.throws(() => validatePlannerRows(bad, ["sonnet", "opus"]));
  }
});

test("repair acceptance fixture plants an independently reviewable LF policy defect", async () => {
  const { fixture } = await import("./live/acceptance-fixture.mjs");
  const { existsSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "lifecycle-repair-fixture-"));
  fixture(root, "auto", { agent: "copilot", scenario: "repair" });
  assert.equal(existsSync(join(root, ".gitattributes")), false);
  assert.match(readFileSync(join(root, "openspec/changes/verify-runner/specs/greeting/spec.md"), "utf8"), /SHALL track.*gitattributes/);
  assert.match(readFileSync(join(root, "openspec/changes/verify-runner/tasks.md"), "utf8"), /independent whole-feature review/);
});

test("recovery signalling refuses own process and stale identities before any signal", async () => {
  const { signalOwned, assertSuccessfulJob } = await import("./live/lifecycle-scenarios.mjs");
  assert.throws(() => signalOwned({ pid: process.pid, createdAt: "current" }, "SIGSTOP"));
  assert.throws(() => signalOwned({ pid: 2147483647, createdAt: "stale" }, "SIGKILL"));
  const job = { session: "real", observedSession: "real", identityConfirmed: true, report: { outcome: "completed" }, worker: { exitedAt: "now", exitCode: 0, completion: { source: "process-exit", session: "real" } } };
  assert.doesNotThrow(() => assertSuccessfulJob(job));
  for (const edit of [j => delete j.worker.completion, j => j.worker.exitCode = null, j => j.observedSession = "other", j => delete j.report]) {
    const bad = structuredClone(job); edit(bad); assert.throws(() => assertSuccessfulJob(bad));
  }
});

test("prompt-only planner forwards invocation stdin as a direct argument to bounded child", async () => {
  const { plannerArguments } = await import("./live/lifecycle-scenarios.mjs");
  assert.deepEqual(plannerArguments({ args: ["-p", "--model", "sonnet"], stdin: "fixture prompt $() `literal`" }), ["-p", "--model", "sonnet", "--", "fixture prompt $() `literal`"]);
  assert.throws(() => plannerArguments({ args: ["-p"] }));
});

test("planner applies actual routine and durable-state model preference without an override", async () => {
  const { validatePlannerRows } = await import("./live/lifecycle-scenarios.mjs");
  const rows = [{ kind: "routine", harness: "claude", model: "sonnet", effort: null, rationale: "H2 clear boundaries and useful tests; omit effort for CLI default" }, { kind: "complex", harness: "claude", model: "opus", effort: null, rationale: "H4 durable concurrency recovery; omit effort for CLI default" }];
  const swapped = structuredClone(rows); swapped[0].model = "opus"; swapped[1].model = "sonnet";
  assert.throws(() => validatePlannerRows(swapped, ["haiku", "sonnet", "opus"]));
  const cheap = structuredClone(rows); cheap[1].model = "haiku";
  assert.throws(() => validatePlannerRows(cheap, ["haiku", "sonnet", "opus"]));
});

test("repair acceptance requires exact greeting and tracked LF policy bytes", async () => {
  const { assertGreetingPolicyBytes } = await import("./live/lifecycle-scenarios.mjs");
  assert.doesNotThrow(() => assertGreetingPolicyBytes("HELLO\n", "*.txt text eol=lf\n"));
  for (const [greeting, policy] of [["HELLO\n", undefined], ["HELLO\n", "*.txt text eol=crlf\n"], ["HELLO\r\n", "*.txt text eol=lf\n"]]) assert.throws(() => assertGreetingPolicyBytes(greeting, policy));
});

test("verified lifecycle receipt cannot pass without affirmative process observation", async () => {
  const { runLifecycle } = await import("./live/lifecycle-acceptance.mjs");
  const { writeFileSync } = await import("node:fs");
  for (const supported of [false, undefined, true]) {
    const result = await runLifecycle({ agent: "claude", scenario: "worker", model: "sonnet", infer: true }, { invoke: async (_, args) => {
      writeFileSync(join(args[2], "receipt.json"), JSON.stringify({ scenario: "worker", verified: true }));
      return { stdout: "", evidence: { exitCode: 0, remainingBeforeCleanup: [], processObservationSupported: supported } };
    } });
    assert.equal(result.status, supported === true ? "PASS" : "BLOCKED");
    assert.equal(result.child.processObservationSupported, supported);
    if (supported !== true) assert.match(result.reason, /process observation/i);
  }
});

test("recovery permits explicit retry but rejects an unproved verified receipt", async () => {
  const { parseLifecycleArgs, runLifecycle } = await import("./live/lifecycle-acceptance.mjs");
  const { writeFileSync } = await import("node:fs");
  assert.equal(parseLifecycleArgs(["recovery", "--model", "auto", "--infer", "--cancel", "--retry"], "copilot").retry, true);
  for (const scenario of ["recovery", "recovery-abrupt"]) {
    const result = await runLifecycle({ agent: "copilot", scenario, model: "auto", infer: true, cancel: true }, { invoke: async (_, args) => {
      writeFileSync(join(args[2], "receipt.json"), JSON.stringify({ scenario, verified: true }));
      return { evidence: { exitCode: 0, remainingBeforeCleanup: [], processObservationSupported: true } };
    } });
    assert.equal(result.status, "FAIL");
  }
});

test("recovery proof fixtures reject detached survivors, uncertainty and wrong signal variants", async () => {
  const { validateRecoveryReceipt } = await import("./live/lifecycle-scenarios.mjs");
  const supervisor = { pid: 10, createdAt: "10" }, launcher = { pid: 11, createdAt: "11" };
  const proof = { version: 1, binding: "a".repeat(64), integrity: "b".repeat(64), receipt: { version: 1, provenance: { version: 1, platform: "linux", machine: "a".repeat(32), boot: "b".repeat(36), namespace: "pid:[1]" }, roots: [supervisor, launcher], members: [supervisor, launcher] } };
  const receipt = { variant: "SIGSTOP-supervisor-before-root-stop-then-SIGKILL", acceptedLateReport: true, supervisorSignal: "SIGKILL", supervisorExitCode: null, supervisorObservedGone: true, launcherObservedGone: true, allObservedGone: true, sentinelSurvived: true, retryBlocked: false, noSuccessfulReceipt: true, rootSession: "old", supervisor, launcher, proof, attempts: [{ id: "old", session: "old", identityConfirmed: true, observedSession: "old", phase: "failed", report: { outcome: "completed" }, worker: { exitCode: null, linuxStop: proof } }] };
  const { createHash } = await import("node:crypto");
  const p = proof.receipt.provenance;
  proof.integrity = createHash("sha256").update(JSON.stringify({ binding: proof.binding, version: 1, provenance: [p.version,p.platform,p.machine,p.boot,p.namespace], roots: [[10,"10"],[11,"11"]], members: [[10,"10"],[11,"11"]] })).digest("hex");
  Object.assign(receipt.attempts[0].worker, { processPlatform: "linux", linuxIdentity: p, linuxNonce: "a".repeat(36), linuxObserved: [supervisor, launcher], exitedAt: new Date().toISOString(), pid: 10, processStart: "10", launcher: { pid: 11, processStart: "11", exitCode: null, exitedAt: new Date().toISOString() } });
  assert.doesNotThrow(() => validateRecoveryReceipt(receipt, { scenario: "recovery" }));
  for (const edit of [r => r.proof.integrity = "f".repeat(64), r => r.attempts[0].identityConfirmed = false, r => r.attempts[0].observedSession = "other", r => r.attempts[0].worker.launcher.exitCode = 0, r => r.attempts[0].worker.linuxObserved.push({ pid: 12, createdAt: "12" }), r => r.supervisorSignal = "SIGTERM", r => r.variant = "SIGKILL-supervisor-before-root-stop", r => { r.proof.receipt.members.push({ pid: 12, createdAt: "linux:12" }); r.allObservedGone = false; }, r => r.allObservedGone = undefined, r => r.launcherObservedGone = false, r => r.supervisorObservedGone = undefined, r => r.sentinelSurvived = false, r => r.proof.receipt.members = [supervisor], r => r.attempts[0].worker.completion = { source: "process-exit" }]) {
    const bad = structuredClone(receipt); edit(bad); assert.throws(() => validateRecoveryReceipt(bad, { scenario: "recovery" }));
  }
  assert.throws(() => validateRecoveryReceipt(receipt, { scenario: "recovery", retry: true }));
  const retried = structuredClone(receipt), at = new Date().toISOString();
  retried.attempts.push({ id: "new", session: "new-session", identityConfirmed: true, observedSession: "new-session", report: { outcome: "completed", commit: "c".repeat(40) }, worker: { pid: 20, processStart: "20", launcher: { pid: 21, processStart: "21", exitedAt: at, exitCode: 0 }, exitedAt: at, exitCode: 0, completion: { source: "process-exit", session: "new-session", at } } });
  retried.freshSupervisor = { pid: 20, started: "20", exitCode: 0, signal: null, processObservationSupported: true, timedOut: false, overflow: false, remainingBeforeCleanup: [] };
  retried.integration = "d".repeat(40); retried.freshRootStop = { session: "new-session", stoppedAt: at, reportAccepted: true };
  assert.doesNotThrow(() => validateRecoveryReceipt(retried, { scenario: "recovery", retry: true }));
  for (const edit of [r => r.freshSupervisor.exitCode = null, r => r.attempts[1].worker.launcher.exitCode = null, r => r.freshSupervisor.started = "wrong", r => r.attempts[1].session = "old", r => r.attempts[1].worker.completion.source = "agent-stop", r => r.freshRootStop.session = "old", r => r.integration = undefined, r => r.attempts[0].phase = "integrated", r => r.attempts[1].worker = r.attempts[0].worker]) {
    const bad = structuredClone(retried); edit(bad); assert.throws(() => validateRecoveryReceipt(bad, { scenario: "recovery", retry: true }));
  }
});


test("recovery cleans its unrelated sentinel when launch rejects", { skip: process.platform !== "linux" }, async () => {
  const cp = await import("node:child_process"), { syncBuiltinESMExports } = await import("node:module");
  const { recoveryScenario } = await import("./live/lifecycle-scenarios.mjs");
  const { processIsGone } = await import("../dist/platform-process.js");
  const original = cp.default.spawn; let sentinel;
  cp.default.spawn = function(...args) { sentinel = original.apply(this, args); return sentinel; }; syncBuiltinESMExports();
  try {
    await assert.rejects(recoveryScenario({ runner: { launch() { throw Error("launch rejected"); } }, timeoutMs: 20000, save() {} }), /launch rejected/);
    assert.ok(sentinel); assert.equal(processIsGone(sentinel.pid), true);
  } finally { cp.default.spawn = original; syncBuiltinESMExports(); if (sentinel && !processIsGone(sentinel.pid)) sentinel.kill("SIGKILL"); }
});
