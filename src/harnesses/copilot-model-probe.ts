import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";

const client = new CopilotClient({ connection: RuntimeConnection.forStdio({ path: process.argv[2] }) });
let stopping: ReturnType<typeof client.stop> | undefined;
const stop = () => stopping ??= client.stop();
let interrupted = false;
const interrupt = (code: number) => {
  if (interrupted) return;
  interrupted = true;
  void stop().then(() => process.exit(code), () => process.exit(code));
};
process.once("SIGINT", () => interrupt(130));
process.once("SIGTERM", () => interrupt(143));
let models;
try {
  await client.start();
  models = await client.listModels();
} finally {
  const errors = await stop();
  if (errors.length) throw new AggregateError(errors, "Could not shut down Copilot model discovery");
}
if (!interrupted) console.log(JSON.stringify(models.map(model => ({ id: model.id, name: model.name }))));
