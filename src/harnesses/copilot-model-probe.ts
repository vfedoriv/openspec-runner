import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";

const client = new CopilotClient({ connection: RuntimeConnection.forStdio({ path: process.argv[2] }) });
try {
  await client.start();
  const models = await client.listModels();
  console.log(JSON.stringify(models.map(model => ({ id: model.id, name: model.name }))));
} finally {
  const errors = await client.stop();
  if (errors.length) throw new AggregateError(errors, "Could not shut down Copilot model discovery");
}
