// Keep the optional SDK and its native artifacts outside ordinary CLI startup.
import type { CopilotClient as Client } from "@microsoft/copilot-sdk";

function failureKind(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/protocol|unsupported.*(?:flag|option)|unknown.*(?:flag|option)/i.test(message)) return "compatibility";
  if (/authenticat|not logged|unauthorized|sign.?in|\b401\b/i.test(message)) return "authentication";
  if (/ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)|artifact|architecture|Exec format|ENOEXEC|ENOENT/i.test(message)) return "runtime";
  return "unavailable";
}
let client: Client | undefined;
let stopping: ReturnType<Client["stop"]> | undefined;
// Published 2.0.1 explicitly returns Promise<Error[]>; errors prevent success.
const stop = () => stopping ??= client ? client.stop() : Promise.resolve([]);
let interrupted = false;
const interrupt = (code: number) => {
  if (interrupted) return;
  interrupted = true;
  void stop().then(() => process.exit(code), () => process.exit(code));
};
process.once("SIGINT", () => interrupt(130));
process.once("SIGTERM", () => interrupt(143));
try {
  const { CopilotClient, RuntimeConnection } = await import("@microsoft/copilot-sdk");
  client = new CopilotClient({
    mode: "coding-agent",
    runtime: RuntimeConnection.forSpawnedStdio({ path: process.argv[2], workingDirectory: process.cwd() }),
  });
  let models;
  try {
    await client.start();
    models = await client.listModels();
  } finally {
    const errors = await stop();
    if (errors.length) throw new AggregateError(errors, "Could not shut down Copilot model discovery");
  }
  if (!interrupted) console.log(JSON.stringify(models.map(model => ({ id: model.id, name: model.name }))));
} catch (error) {
  // Only fixed codes cross the process boundary; SDK/provider diagnostics may contain secrets.
  if (!interrupted) {
    console.log(JSON.stringify({ failure: failureKind(error) }));
    // Nonzero status makes the child boundary terminate any residual runtime.
    process.exitCode = 1;
  }
}
