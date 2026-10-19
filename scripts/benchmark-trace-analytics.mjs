#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {createTraceManager} from '../dist/traces.js';
const rows=Number(process.argv[process.argv.indexOf('--rows')+1])||3_000_000;
const sessionCount=process.argv.includes('--sessions')?Number(process.argv[process.argv.indexOf('--sessions')+1]):1000;
const root=await fs.mkdtemp(path.join(os.tmpdir(),'multivibe-analytics-bench-'));
let manager;
try {
  const journal=path.join(root,'trace.jsonl'),history=path.join(root,'history.jsonl'),db=path.join(root,'analytics.sqlite');
  const file=await fs.open(history,'w');
  const end=Math.floor(Date.now()/3_600_000)*3_600_000;
  for(let start=0;start<rows;start+=1000){let data='';for(let i=start;i<Math.min(rows,start+1000);i++){data+=JSON.stringify({id:`event-${i}`,at:end-Math.floor((rows-i)/10000)*3_600_000,route:'/responses',status:200,isError:false,stream:true,latencyMs:100,lifecycleState:'completed',provider:'openai',model:'gpt-4o-mini',usageStatus:'measured',tokensInput:20,tokensOutput:5,tokensTotal:25,application:'bench',codexSessionId:`session-${i%sessionCount}`,clientRequestId:`request-${i}`,projectId:`project-${i%10}`})+'\n';}await file.write(data);}
  await file.close();
  let peakRss=process.memoryUsage().rss;
  const memoryTimer=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);},100);memoryTimer.unref();
  const lag=monitorEventLoopDelay({resolution:20});lag.enable();
  manager=createTraceManager({filePath:journal,historyFilePath:history,indexedHistoryPath:db,externalWriter:true});
  const start=performance.now();await manager.initialize();
  const progress=setInterval(()=>{const status=manager.getPersistenceStatus().analytics;console.log(JSON.stringify({phase:"migration",elapsedMs:Math.round(performance.now()-start),...status}));},10000);progress.unref();await manager.queryAnalytics('sync',{});
  clearInterval(progress);
  const migrationMs=performance.now()-start;console.log(JSON.stringify({phase:"migration-complete",rows,migrationMs}));
  const bounds={sinceMs:end-24*3_600_000,untilMs:end};
  const measurements={};
  for(const [name,action,args] of [['stats','stats',bounds],['usage','usage',bounds],['sessions','sessions',{...bounds,limit:10}],['sessionsRepeat','sessions',{...bounds,limit:10,untilMs:end+1}],['allTimeSessions','sessions',{limit:10,untilMs:end}],['allTimeSessionsRepeat','sessions',{limit:10,untilMs:end+1}]]){
    const t=performance.now();const result=await manager.queryAnalytics(action,args);measurements[name]={ms:Math.round(performance.now()-t),returnedSessions:result.sessions?.length};
    console.log(JSON.stringify({phase:name,...measurements[name]}));
    if(name==='stats')assert.equal(result.stats.totals.tokensTotal,Math.min(rows,249999)*25);
    if(name==='allTimeSessions')assert.equal(result.summary.totalAttempts,rows);
  }
  await manager.queryAnalytics('append',{entries:[{id:'new-live-event',at:end+2,route:'/responses',status:200,isError:false,stream:true,latencyMs:100,lifecycleState:'completed',provider:'openai',model:'gpt-4o-mini',usageStatus:'measured',tokensInput:20,tokensOutput:5,tokensTotal:25,application:'bench',codexSessionId:'session-0',clientRequestId:'new-live-request',projectId:'project-0'}]});
  const updateStart=performance.now();const updated=await manager.queryAnalytics('sessions',{untilMs:end+3,limit:10});
  measurements.incrementalSession={ms:Math.round(performance.now()-updateStart)};assert.equal(updated.summary.totalAttempts,rows+1);
  const all=await manager.getTraceStats();assert.equal(all.stats.totals.tokensTotal,(rows+1)*25);
  lag.disable();clearInterval(memoryTimer);console.log(JSON.stringify({rows,sessionCount,peakRssMiB:Math.round(peakRss/1048576),migrationMs:Math.round(migrationMs),measurements,parentEventLoopMaxMs:lag.max/1e6,rssMiB:Math.round(process.memoryUsage().rss/1048576),totalsVerified:true},null,2));
} finally {await manager?.close();await fs.rm(root,{recursive:true,force:true});}
