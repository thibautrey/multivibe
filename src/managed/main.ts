import { createManagedRuntime, loadManagedRuntimeConfig } from "./runtime.js";
const config = loadManagedRuntimeConfig(process.env);
const { server } = await createManagedRuntime(config);
server.listen(config.port, config.host);
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => { process.exitCode = 0; });
  // Existing executions keep their internal deadline and persist their receipt.
  setTimeout(() => { server.closeAllConnections(); process.exitCode = 1; }, config.executionTimeoutMs + 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
