import { test } from "node:test";

function scoped(reason, unsupported) {
  return (name, options, body) => test(name, {
    ...(typeof options === "object" ? options : {}),
    ...(process.platform === "win32" && unsupported(name) ? { skip: reason } : {}),
  }, body ?? options);
}
export const delegatedContextTest = scoped("Windows delegated-context protection remains explicitly unsupported", () => true);
export const optionalBackendTest = scoped("Optional terminal/worktree backend is not verified on native Windows", () => true);
export const localRunnerTest = scoped("This case requires the optional Herdr/Orca backend, not the Windows Git/manual workflow", name =>
  /orca|herdr|worktrunk|owned terminal|terminal closure failure|unacknowledged worker exit/i.test(name));
