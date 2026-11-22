import { test } from "node:test";
import assert from "node:assert/strict";
const worker = await import("../dist/harnesses/copilot-supervisor.js").catch(() => ({}));
test("Store launch rejects hosts without scoped write-denial support before dispatch", async () => {
  const { getHarness } = await import("../dist/harnesses/registry.js");
  const { superviseWorker } = await import("../dist/worker.js");
  const harness = getHarness("copilot"), original = harness.capabilities;
  harness.capabilities = async () => ({ supported: true, features: { storeReadPermissions: false }, reasons: [] });
  try {
    await assert.rejects(superviseWorker({ agent: "copilot", path: process.cwd(), settings: { model: "auto" } }, process.cwd(), "prompt", () => {}, undefined, {}), /Store workers require --deny-tool/);
  } finally { harness.capabilities = original; }
});
test("editor launcher success cannot finish a worker before report and stop", () => {
  assert.equal(typeof worker.copilotDecision, "function");
  assert.equal(worker.copilotDecision(undefined, 0, true), undefined);
  const lease = { session: "s", status: "stopped", reportAccepted: true };
  assert.equal(worker.copilotDecision(lease, 0, true), 0);
  assert.equal(worker.copilotDecision({ ...lease, reportAccepted: false }, 0, true), 1);
  assert.equal(worker.copilotDecision({ ...lease, error: "canceled" }, 0, true), 1);
  assert.equal(worker.copilotDecision(lease, undefined, false), undefined);
  assert.equal(worker.copilotDecision(lease, 9, false), 9);
  assert.equal(worker.copilotDecision(undefined, 0, false), 1);
});


test("legacy reserved CLI attempts require explicit retry before launching a new session", async () => {
  await assert.rejects(worker.superviseCopilot({ id: "old", agent: "copilot", expectedSession: "reserved", path: process.cwd(), settings: { model: "auto" } }, process.cwd(), "prompt", () => {}, () => {}), /Legacy Copilot.*explicitly retry/);
});
