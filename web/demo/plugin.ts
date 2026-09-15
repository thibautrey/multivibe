import {localMemoryBudget} from '../../src/model-memory-budget';
import { createDiscoveryMemory } from '../../src/model-discovery-memory';
import { createCachedModelBenchmarkClient } from '../../src/model-benchmark-cache';
import { createModelBenchmarkClient } from '../../src/model-benchmarks';
import { createRecommendationEvidence, benchmarkProfiles } from '../../src/model-recommendation-evidence';
import { createOpenModelCatalog } from '../../src/open-model-catalog';
import { rankOpenModels, catalogSorts, type CatalogNeed, type CatalogSort } from '../../src/open-model-ranking';
import path from 'node:path';
import os from 'node:os';
const loadOpenModelCatalog = createOpenModelCatalog(fetch, Date.now, path.join(os.tmpdir(), 'multivibe-demo-open-catalog-v2.json'));
const benchmarkClient = createCachedModelBenchmarkClient(createModelBenchmarkClient(), {path:path.join(os.tmpdir(), 'multivibe-demo-benchmarks-v1.json')});
const evidenceFor = createRecommendationEvidence(benchmarkClient, Date.now, createDiscoveryMemory());
import type { Plugin } from "vite";
import { createDemoApi } from "./api";

/** Development-only middleware. No gateway, storage or credentials. Public model discovery uses the live Hub API. */
export function demoApiPlugin(): Plugin {
  return {
    name: "multivibe-demo-api",
    apply: "serve",
    configureServer(server) {
      const stopCatalog = loadOpenModelCatalog.start();
      server.httpServer?.once("close", stopCatalog);
      const role = process.env.MULTIVIBE_DEMO_WORKSPACE ?? "personal";
      if (!["personal", "owner", "admin", "member", "billing"].includes(role)) throw new Error("Invalid demo workspace");
      const respond = createDemoApi(Date.now(), role as "personal" | "owner" | "admin" | "member" | "billing", process.env.MULTIVIBE_DEMO_HOST === "1");
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? "/", "http://demo.invalid").pathname;
        if (path === '/admin/model-recommendations' && req.method === 'GET') {
          const params = new URL(req.url!, 'http://demo.invalid').searchParams;
          const need = params.get('need') ?? 'writing'; const sort = params.get('sort') ?? 'recommended';
          if (!['writing','coding','translation','documents'].includes(need) || !catalogSorts.includes(sort as CatalogSort)) { res.statusCode=400; res.end('{}'); return; }
          void loadOpenModelCatalog().then(async catalog => { const benchmark = params.get('benchmark') ?? undefined; if (benchmark && !benchmarkProfiles.some(p=>p.id===benchmark)) {res.statusCode=400;res.end('{}');return;} const evidence = await evidenceFor(catalog,need as CatalogNeed,benchmark); const budgetMiB=params.has('memory_gib') ? Number(params.get('memory_gib'))*1024 : undefined; if(budgetMiB !== undefined && (!Number.isFinite(budgetMiB)||budgetMiB<=0||budgetMiB>4096*1024)){res.statusCode=400;res.end('{}');return;} const memory=os.platform()==='darwin' && os.arch()==='arm64' ? localMemoryBudget(os.totalmem(),budgetMiB) : budgetMiB===undefined?undefined:{budgetMiB}; res.setHeader('content-type','application/json'); res.end(JSON.stringify({catalog,host:null,memory,benchmarks:{selected:evidence.profile?.id,options:evidence.options,coverage:evidence.coverage},recommendations:rankOpenModels(catalog,need as CatalogNeed,sort as CatalogSort,[],Date.now(),{...evidence,memory})})); }).catch(()=>{res.statusCode=503;res.end('{}');});
          return;
        }
        if (path === '/admin/open-model-family' && req.method === 'GET') {
          const model = new URL(req.url!, 'http://demo.invalid').searchParams.get('model') ?? '';
          void loadOpenModelCatalog.family(model).then(models=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({models,source:'Hugging Face',limit:100}));}).catch(()=>{res.statusCode=503;res.end('{}');}); return;
        }
        if (path === '/admin/open-model-catalog' && req.method === 'GET') {
          void loadOpenModelCatalog().then(body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); }).catch(() => { res.statusCode = 503; res.end(JSON.stringify({ error: 'Public catalog unavailable' })); });
          return;
        }
        if (!/^\/(admin|v1|auth)(\/|$)/.test(path) && path !== "/health") return next();
        try {
          const result = respond(req.method ?? "GET", req.url ?? "/");
          res.statusCode = result.status;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.setHeader("x-multivibe-demo", "true");
          res.end(req.method === "HEAD" ? undefined : JSON.stringify(result.body));
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "Invalid demo request" }));
        }
      });
    },
  };
}
