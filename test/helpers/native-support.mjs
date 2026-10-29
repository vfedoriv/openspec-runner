import { test } from "node:test";

function scoped(reason, unsupported) {
  return (name, options, body) => test(name, {
    ...(typeof options === "object" ? options : {}),
    ...(process.platform === "win32" && unsupported(name) ? { skip: reason } : {}),
  }, body ?? options);
}
export const delegatedContextTest = scoped("Windows delegated-context protection remains explicitly unsupported", () => true);
export const optionalBackendTest = test;
export const localRunnerTest = test;
