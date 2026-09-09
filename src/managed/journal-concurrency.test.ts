import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function processClaim(directory: string): Promise<string> {
  const sourceMode = import.meta.url.endsWith(".ts");
  const journal = new URL(sourceMode ? "./journal.ts" : "./journal.js", import.meta.url).href;
  const source = `import { ExecutionJournal } from ${JSON.stringify(journal)};
    const journal = new ExecutionJournal(process.argv[1]);
    try { await journal.claim({attemptId:"shared-attempt",reservationId:"r1",routeVersionId:"v1",bodySha256:"a".repeat(64)}); process.stdout.write("claimed"); }
    catch (error) { if(error.message === "execution_already_claimed") process.stdout.write("fenced"); else throw error; }`;
  return new Promise((resolve,reject)=>execFile(process.execPath,[...(sourceMode ? ["--import", "tsx"] : []),"--input-type=module","-e",source,directory],(error,stdout)=>error?reject(error):resolve(stdout)));
}
test("independent Core processes share one durable attempt fence and restart cannot replay it", async()=>{
  const directory=await mkdtemp(join(tmpdir(),"mv-core-replica-test-"));
  try {
    const completed=await Promise.allSettled(Array.from({length:8},()=>processClaim(directory)));
    const outcomes=completed.map(result=>{ if(result.status==="rejected") throw result.reason; return result.value; });
    assert.equal(outcomes.filter(value=>value==="claimed").length,1);
    assert.equal(outcomes.filter(value=>value==="fenced").length,7);
    // The winning process has exited without a receipt: execution is uncertain,
    // so restarting a worker must not remove the claim or dispatch again.
    assert.equal(await processClaim(directory),"fenced");
  } finally { await rm(directory,{recursive:true,force:true}); }
});
