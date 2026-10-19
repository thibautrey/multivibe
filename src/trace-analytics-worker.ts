import { parentPort, workerData } from "node:worker_threads";
import { TraceAnalyticsStore } from "./trace-analytics-store.js";

const store = await TraceAnalyticsStore.open(workerData, status => parentPort!.postMessage({ status }));
parentPort!.postMessage({ opened: true });
parentPort!.postMessage({ status: store.status });
let timer: ReturnType<typeof setTimeout> | undefined;
let stopping = false;
async function ingest() {
  try { await store.sync(); } catch { /* status includes the error; retry the same committed cursor */ }
  if (!stopping) timer=setTimeout(ingest, 500);
}
parentPort!.on("message", async ({ id, action, args }) => {
  try {
    let value;
    if (action === "close") { stopping=true;clearTimeout(timer);await store.close(); }
    else if (action === "sync") { await store.sync(); value=store.status; }
    else value=store.query(action,args);
    parentPort!.postMessage({id,value});
  } catch (error) { parentPort!.postMessage({id,error:(error as Error).message}); }
});
void ingest();
