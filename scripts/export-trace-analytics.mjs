#!/usr/bin/env node
// A consistent, streaming rollback export. The original JSONL is never overwritten.
import Database from 'better-sqlite3';
import fs from 'node:fs';
const [databasePath, outputPath]=process.argv.slice(2);
if(!databasePath || !outputPath) throw new Error('Usage: export-trace-analytics.mjs <index.sqlite> <new-history.jsonl>');
const db=new Database(databasePath,{readonly:true,fileMustExist:true});
let output,rows=0;
try {
  output=fs.openSync(outputPath,'wx',0o600);
  db.transaction(()=>{
    let batch='';
    for(const {payload} of db.prepare('SELECT payload FROM entries ORDER BY at,id').iterate()) {
      batch+=payload+'\n';rows++;
      if(batch.length>=65536) {fs.writeSync(output,batch);batch='';}
    }
    if(batch)fs.writeSync(output,batch);
  })();
  fs.fsyncSync(output);
  console.log(JSON.stringify({exported:rows,outputPath}));
} finally {if(output!==undefined)fs.closeSync(output);db.close();}
