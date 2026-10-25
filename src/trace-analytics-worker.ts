import { ModelsDevCatalog } from "./ai-sdk/models-dev-catalog.js";
import { installModelsDevPricing } from "./model-pricing.js";
import { parentPort, workerData } from "node:worker_threads";
import { TraceAnalyticsStore } from "./trace-analytics-store.js";

const pricing = workerData.pricingCachePath ? new ModelsDevCatalog({
  cachePath: workerData.pricingCachePath, onUpdate: installModelsDevPricing,
}) : undefined;
let initializedPricing = false;
const store = await TraceAnalyticsStore.open(workerData, status => parentPort!.postMessage({ status }));
parentPort!.postMessage({ opened: true });
parentPort!.postMessage({ status: store.status });
let timer: ReturnType<typeof setTimeout> | undefined;
let stopping = false;
async function ingest() {
  try {
    if (pricing) {
      if (!initializedPricing) {
        await pricing.ensure();
        // Only the analytics worker waits for a cold price fetch. Inference stays available.
        await pricing.refresh();
        initializedPricing = true;
      } else await pricing.ensure();
      if (pricing.state().fetchedAt) store.enablePricingBackfill();
    }
    await store.sync();
  } catch { /* status includes the error; retry the same committed cursor */ }
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
