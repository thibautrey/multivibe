import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { discoverNativeSessions, readNativeMessages } from "./discovery.js";

function fixture(t:test.TestContext){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"multivibe-native-history-"));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const write=(relative:string,records:unknown[])=>{const file=path.join(home,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,records.map(v=>JSON.stringify(v)).join("\n")+"\n");return file;};
  const read=(id:string)=>{const sources=discoverNativeSessions(id,home);assert.equal(sources.length,1);return readNativeMessages(id,sources[0].sourceId,home);};
  return {home,write,read};
}
test("native file histories normalize Codex, Claude, Pi and Gemini without starting or modifying a session",t=>{
  const {home,write,read}=fixture(t);
  const codex=write(".codex/sessions/2026/10/26/rollout.jsonl",[
    {type:"session_meta",payload:{id:"codex-native",cwd:"/project"}},
    {type:"event_msg",payload:{type:"user_message",message:"duplicate event"}},
    {type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"Question"}]}},
    {type:"response_item",payload:{type:"reasoning",content:[{type:"text",text:"private reasoning"}]}},
    {type:"response_item",payload:{type:"message",role:"assistant",content:[{type:"output_text",text:"Answer"}]}},
  ]);
  const original=fs.readFileSync(codex,"utf8");
  assert.deepEqual(read("openai-codex").messages.map(v=>[v.role,v.content]),[["user","Question"],["assistant","Answer"]]);
  assert.equal(fs.readFileSync(codex,"utf8"),original);
  write(".claude/projects/project/session.jsonl",[
    {type:"file-history-snapshot",snapshot:{}},
    {type:"user",sessionId:"claude-native",cwd:"/project",uuid:"u",message:{role:"user",content:"Hello"}},
    {type:"assistant",sessionId:"claude-native",uuid:"a",message:{role:"assistant",content:[{type:"thinking",thinking:"hidden"},{type:"text",text:"World"}]}},
    {type:"assistant",sessionId:"claude-native",isSidechain:true,message:{role:"assistant",content:"subagent output"}},
  ]);
  assert.deepEqual(read("claude-code").messages.map(v=>v.content),["Hello","World"]);
  write(".pi/agent/sessions/project/session.jsonl",[
    {type:"session",id:"pi-native",cwd:"/project"},
    {type:"message",id:"u",parentId:null,message:{role:"user",content:"Hello"}},
    {type:"message",id:"old",parentId:"u",message:{role:"assistant",content:"Old branch"}},
    {type:"message",id:"new",parentId:"u",message:{role:"assistant",content:[{type:"text",text:"Current branch"}]}},
  ]);
  assert.deepEqual(read("pi").messages.map(v=>v.content),["Hello","Current branch"]);
  write(".gemini/tmp/project/chats/session.json",[{sessionId:"gemini-native",messages:[{id:"u",type:"user",content:"Hello"},{id:"a",type:"gemini",content:"World"}]}]);
  assert.deepEqual(read("gemini-cli").messages.map(v=>v.content),["Hello","World"]);
  assert.equal(read("gemini-cli").source.canContinue,false);
  fs.appendFileSync(codex,JSON.stringify({type:"response_item",payload:{type:"message",role:"assistant",content:"New external reply"}})+"\n"+'{"partial":');
  const updated=read("openai-codex");assert.equal(updated.messages.at(-1)?.content,"New external reply");assert.equal(updated.readOnly,true);
  assert.throws(()=>readNativeMessages("openai-codex","untrusted-path",home),/not found/u);
});
test("native database histories normalize Hermes and OpenCode in read-only connections",t=>{
  const {home,read}=fixture(t);
  const hermes=path.join(home,".hermes/state.db");fs.mkdirSync(path.dirname(hermes),{recursive:true});
  const h=new Database(hermes);h.exec("CREATE TABLE sessions(id TEXT,title TEXT,cwd TEXT,started_at INTEGER); CREATE TABLE messages(id TEXT,session_id TEXT,role TEXT,content TEXT)");
  h.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run("h","Hermes conversation","/project",1793000000);
  h.prepare("INSERT INTO messages VALUES(?,?,?,?)").run("u","h","user","Hello");h.close();
  const before=fs.readFileSync(hermes);assert.equal(read("hermes-agent").messages[0].content,"Hello");assert.equal(read("hermes-agent").source.updatedAt,1793000000000);assert.deepEqual(fs.readFileSync(hermes),before);
  const opencode=path.join(home,".local/share/opencode/opencode.db");fs.mkdirSync(path.dirname(opencode),{recursive:true});
  const o=new Database(opencode);o.exec("CREATE TABLE session(id TEXT,title TEXT,directory TEXT,time_updated INTEGER); CREATE TABLE message(id TEXT,session_id TEXT,data TEXT); CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,data TEXT)");
  o.prepare("INSERT INTO session VALUES(?,?,?,?)").run("o","OpenCode conversation","/project",1793000000000);
  o.prepare("INSERT INTO message VALUES(?,?,?)").run("a","o",JSON.stringify({role:"assistant"}));
  o.prepare("INSERT INTO part VALUES(?,?,?,?)").run("text","a","o",JSON.stringify({type:"text",text:"Hello from OpenCode"}));o.close();
  assert.deepEqual(read("opencode").messages.map(v=>[v.role,v.content]),[["assistant","Hello from OpenCode"]]);
});
