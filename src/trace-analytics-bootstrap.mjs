// Source-level tests load TypeScript through a fixed module, never generated code.
// Compiled releases launch trace-analytics-worker.js directly.
import { workerData } from "node:worker_threads";
import { tsImport } from "tsx/esm/api";

await tsImport(workerData.sourceModule, workerData.sourceParent);
