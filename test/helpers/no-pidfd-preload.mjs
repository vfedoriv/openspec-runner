// Account-free test simulation: leave all ordinary executable/process support intact.
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const execute = cp.execFileSync;
cp.execFileSync = function(command, ...args) {
  if (command === "python3") throw Object.assign(new Error("simulated unavailable Python pidfd helper"), { code: "ENOENT" });
  return execute.call(this, command, ...args);
};
syncBuiltinESMExports();
