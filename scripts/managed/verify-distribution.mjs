import assert from "node:assert/strict";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {execFileSync} from "node:child_process";
const directory=await mkdtemp(join(tmpdir(),"managed-distribution-"));
try {
 for(const entry of ["core","injector"]){
  const output=join(directory,entry);
  execFileSync(process.execPath,["scripts/managed/package-runtime.mjs",output,entry],{stdio:"inherit"});
  const files=JSON.parse(await readFile(join(output,"runtime-files.json"),"utf8"));
  const required=entry==="core"?["managed/main.js","managed/runtime.js","managed/injector-client.js"]:
    ["managed/injector-main.js","managed/injector-runtime.js","managed/provider.js","managed/native-anthropic.js"];
  const forbidden=entry==="core"?["managed/native-anthropic.js","managed/provider.js","managed/provider-proxy-fetch.js","managed/injector.js","managed/injector-runtime.js"]:
    ["managed/executor.js","managed/http.js","managed/runtime.js"];
  for(const file of required)assert.ok(files.includes(file),`${entry} missing ${file}`);
  for(const file of forbidden)assert.ok(!files.includes(file),`${entry} must exclude ${file}`);
  // Import the isolated package, so successful source-checkout resolution
  // cannot hide an accidental dependency on node_modules or desktop files.
  const runtime=entry==="core"?"managed/runtime.js":"managed/injector-runtime.js";
  execFileSync(process.execPath,["--input-type=module","-e",`await import(${JSON.stringify(pathToFileURL(join(output,runtime)).href)})`],{cwd:output,stdio:"inherit"});
  assert.ok(!files.some(file=>file==="server.js"||file.startsWith("node_modules/")));
 }
 console.log("Managed distribution import boundaries verified");
}finally{await rm(directory,{recursive:true,force:true});}
