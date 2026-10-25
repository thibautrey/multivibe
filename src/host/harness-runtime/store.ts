import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { fail, fingerprint, identifier, redact, requiredText, type HarnessAttachment, type HarnessCommand, type HarnessCommandReceipt, type HarnessEvent, type HarnessSession, type HarnessTarget, type PendingInteraction } from "./types.js";

export class HarnessRuntimeStore {
  readonly db: any;
  constructor(readonly root: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(root, "runtime.sqlite"));
    fs.chmodSync(path.join(root, "runtime.sqlite"), 0o600);
    this.db.pragma("journal_mode = WAL"); this.db.pragma("foreign_keys = ON"); this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id,seq);
      CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS targets(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS registrations(id TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }
  session(id: string): HarnessSession {
    const row = this.db.prepare("SELECT value FROM sessions WHERE id=?").get(identifier(id));
    return row ? JSON.parse(row.value) : fail("Session not found", 404);
  }
  sessions(): HarnessSession[] { return this.db.prepare("SELECT value FROM sessions").all().map((r: any) => JSON.parse(r.value)).sort((a: HarnessSession,b: HarnessSession)=>b.updatedAt-a.updatedAt); }
  save(session: HarnessSession) {
    session.revision++; session.updatedAt = Date.now();
    this.db.prepare("INSERT INTO sessions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(session.id, JSON.stringify(session));
  }
  event(sessionId: string, type: string, payload: unknown, turnId?: string, itemId?: string): HarnessEvent {
    const event = { sessionId, type, payload: redact(payload), ...(turnId ? {turnId}:{}), ...(itemId ? {itemId}:{}), createdAt: Date.now() };
    let bytes = JSON.stringify(event);
    if (Buffer.byteLength(bytes) > 1024 * 1024) {
      const original=Buffer.from(JSON.stringify(event.payload));
      const attachment=this.attach(sessionId,`${type.replace(/[^a-zA-Z0-9._-]/gu,"-")}.json`,"application/json",original.subarray(0,16*1024*1024).toString("base64"));
      event.payload={truncated:true,attachment,preview:original.subarray(0,4000).toString("utf8"),complete:original.length<=16*1024*1024};
      bytes=JSON.stringify(event);
    }
    const result = this.db.prepare("INSERT INTO events(session_id,value) VALUES(?,?)").run(sessionId, bytes);
    return { ...event, seq: Number(result.lastInsertRowid) };
  }
  events(sessionId: string, after = 0, limit = 250): HarnessEvent[] {
    this.session(sessionId);
    return this.db.prepare("SELECT seq,value FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?").all(sessionId, after, Math.min(500,Math.max(1,limit))).map((r: any)=>({...JSON.parse(r.value),seq:r.seq}));
  }
  commands(sessionId: string): HarnessCommandReceipt[] {
    return this.db.prepare("SELECT value FROM commands WHERE session_id=?").all(sessionId).map((r: any)=>JSON.parse(r.value)).sort((a: HarnessCommandReceipt,b: HarnessCommandReceipt)=>a.ordinal-b.ordinal);
  }
  receipt(id: string): HarnessCommandReceipt | undefined { const row=this.db.prepare("SELECT value FROM commands WHERE id=?").get(id); return row ? JSON.parse(row.value) : undefined; }
  command(sessionId: string, command: HarnessCommand): { receipt: HarnessCommandReceipt; fresh: boolean } {
    return this.db.transaction(() => {
      const hash=fingerprint({sessionId,command});
      const row=this.db.prepare("SELECT value,fingerprint FROM commands WHERE id=?").get(command.id);
      if (row) { if(row.fingerprint!==hash) fail("Operation identifier already used for different content",409); return {receipt:JSON.parse(row.value),fresh:false}; }
      const receipt: HarnessCommandReceipt={id:command.id,sessionId,command,state:"queued",createdAt:Date.now(),ordinal:Date.now()*1000+this.commands(sessionId).length};
      this.db.prepare("INSERT INTO commands VALUES(?,?,?,?)").run(command.id,sessionId,hash,JSON.stringify(receipt));
      return {receipt,fresh:true};
    })();
  }
  saveReceipt(receipt: HarnessCommandReceipt) { this.db.prepare("UPDATE commands SET value=? WHERE id=?").run(JSON.stringify(receipt),receipt.id); }
  interaction(value: PendingInteraction) { this.db.prepare("INSERT INTO interactions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(value.id,value.sessionId,JSON.stringify(value)); }
  interactions(sessionId: string): PendingInteraction[] { return this.db.prepare("SELECT value FROM interactions WHERE session_id=?").all(sessionId).map((r: any)=>JSON.parse(r.value)); }
  targets(): HarnessTarget[] { return [{id:"local",name:"Ce Mac / Host",kind:"local"}, ...this.db.prepare("SELECT value FROM targets").all().map((r: any)=>JSON.parse(r.value))]; }
  saveTarget(value: HarnessTarget) {
    identifier(value.id); requiredText(value.name,128);
    if (value.id === "local" || !["ssh","container"].includes(value.kind)) fail("Invalid execution target");
    if(value.kind==="ssh") {
      if(!value.sshHost || !/^[a-zA-Z0-9][a-zA-Z0-9@._-]{0,200}$/u.test(value.sshHost)) fail("Use a configured SSH host alias");
      if(!value.bridgePath || !path.posix.isAbsolute(value.bridgePath) || /[\r\n\0]/u.test(value.bridgePath)) fail("An absolute remote bridge path is required");
    }
    if(value.kind==="container" && (!value.container || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(value.container))) fail("Invalid container name");
    this.db.prepare("INSERT INTO targets VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(value.id,JSON.stringify(value));
  }
  target(id: string): HarnessTarget { return this.targets().find(v=>v.id===id) ?? fail("Execution target not found",404); }
  registrations():Array<{id:string;name:string;executable:string;args:string[]}> { return this.db.prepare("SELECT value FROM registrations").all().map((r:any)=>JSON.parse(r.value)); }
  register(value:any) {
    identifier(value.id);requiredText(value.name,128);requiredText(value.executable,4096);
    if(!path.isAbsolute(value.executable) || !fs.statSync(value.executable).isFile())fail("Choose an installed ACP executable by absolute path");
    if(!Array.isArray(value.args) || value.args.length>32 || value.args.some((v:any)=>typeof v!=="string" || v.includes("\0") || v.length>4096))fail("Invalid ACP launch arguments");
    const registration={id:value.id,name:value.name,executable:value.executable,args:value.args};
    this.db.prepare("INSERT INTO registrations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(value.id,JSON.stringify(registration));return registration;
  }
  attach(sessionId: string, name: unknown, mimeType: unknown, base64: unknown, expectedHash?: unknown): HarnessAttachment {
    this.session(sessionId); name=requiredText(name,255); mimeType=requiredText(mimeType,128);
    if(typeof base64!=="string" || base64.length>24*1024*1024 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64)) fail("Invalid attachment or file exceeds 16 MiB",413);
    const bytes=Buffer.from(base64,"base64"); if(!bytes.length || bytes.length>16*1024*1024) fail("File exceeds 16 MiB",413);
    const sha256=createHash("sha256").update(bytes).digest("hex");
    if(expectedHash!==undefined && expectedHash!==sha256) fail("Attachment checksum mismatch",409);
    for(const row of this.db.prepare("SELECT value FROM attachments WHERE session_id=?").all(sessionId)) {
      const existing=JSON.parse(row.value) as HarnessAttachment;
      if(existing.sha256===sha256 && existing.name===path.basename(name as string) && existing.mimeType===mimeType){this.attachment(sessionId,existing.id);return existing;}
    }
    const info: HarnessAttachment={id:randomUUID(),name:path.basename(name as string),mimeType:mimeType as string,size:bytes.length,sha256};
    const folder=path.join(this.root,"attachments",sessionId); fs.mkdirSync(folder,{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(folder,info.id),bytes,{mode:0o600,flag:"wx"});
    this.db.prepare("INSERT INTO attachments VALUES(?,?,?)").run(info.id,sessionId,JSON.stringify(info)); return info;
  }
  attachment(sessionId: string,id: string) {
    const row=this.db.prepare("SELECT value FROM attachments WHERE id=? AND session_id=?").get(identifier(id),sessionId);
    if(!row) fail("Attachment does not belong to this session",404);
    const info=JSON.parse(row.value) as HarnessAttachment; const file=path.join(this.root,"attachments",sessionId,id); const data=fs.readFileSync(file);
    if(createHash("sha256").update(data).digest("hex")!==info.sha256) fail("Attachment integrity check failed",409);
    return {info,path:file,data};
  }
  delete(sessionId: string) {
    const s=this.session(sessionId); if(s.activeTurnId) fail("Stop this session before deleting it",409);
    this.db.prepare("DELETE FROM sessions WHERE id=?").run(sessionId);
    fs.rmSync(path.join(this.root,"attachments",sessionId),{recursive:true,force:true});
  }
  close() { this.db.close(); }
}
