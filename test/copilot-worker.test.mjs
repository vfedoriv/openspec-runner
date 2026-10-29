import { test } from "node:test";
import assert from "node:assert/strict";
const worker = await import("../dist/harnesses/copilot-supervisor.js").catch(() => ({}));
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
