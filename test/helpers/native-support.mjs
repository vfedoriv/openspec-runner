import { test } from "node:test";

function scoped(reason, unsupported) {
  return (name, options, body) => test(name, {
    ...(typeof options === "object" ? options : {}),
    ...(process.platform === "win32" && unsupported(name) ? { skip: reason } : {}),
  }, body ?? options);
}
export const delegatedContextTest = scoped("POSIX delegated fixture; native Windows uses the NTFS acceptance fixtures", () => true);
export const optionalBackendTest = test;
export const localRunnerTest = test;
