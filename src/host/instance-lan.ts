import {createHash,createPrivateKey,createPublicKey,X509Certificate} from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import type {IncomingMessage,ServerResponse} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import type {InstanceRelay} from './instance-relay.js';
import {fail} from './harness-runtime/types.js';

export type InstanceLANIdentity={publicKey:string;host:string;port:number};
export const certificatePin=(pem:string)=>createHash('sha256').update(new X509Certificate(pem).raw).digest('base64url');
export function localLANHost():string {
 try {const value=execFileSync('/usr/sbin/scutil',['--get','LocalHostName'],{encoding:'utf8',timeout:2000}).trim();if(/^[A-Za-z0-9-]{1,63}$/.test(value))return value.toLowerCase()+'.local';} catch { }
 const value=os.hostname().split('.')[0]!.replace(/[^A-Za-z0-9-]/g,'-').slice(0,63);return (value||'multivibe')+'.local';
}
function credentials(directory:string):{key:string;cert:string} {
 const keyFile=path.join(directory,'instance-lan-key.pem'),certFile=path.join(directory,'instance-lan-cert.pem');
 let regenerate=!fs.existsSync(keyFile)||!fs.existsSync(certFile);
 if(!regenerate){
  try {
   const certificate=new X509Certificate(fs.readFileSync(certFile,'utf8'));
   const certificateKey=certificate.publicKey.export({format:'der',type:'spki'}),privateKey=createPublicKey(createPrivateKey(fs.readFileSync(keyFile,'utf8'))).export({format:'der',type:'spki'});
   regenerate=!certificate.subjectAltName||!certificateKey.equals(privateKey);
  }
  catch {regenerate=true;}
 }
 if(regenerate){
  fs.mkdirSync(directory,{recursive:true,mode:0o700});const temporary=path.join(directory,'.instance-lan-'+process.pid+'-'+Date.now());
  const key=temporary+'.key',cert=temporary+'.crt';
  const result=spawnSync('/usr/bin/openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-pkeyopt','ec_param_enc:named_curve','-sha256','-nodes','-keyout',key,'-out',cert,'-subj','/CN=MultiVibe LAN','-addext','basicConstraints=critical,CA:FALSE','-addext','keyUsage=critical,digitalSignature','-addext','extendedKeyUsage=serverAuth','-addext','subjectAltName=DNS:multivibe.local','-days','3650'],{stdio:'ignore',timeout:10000});
  if(result.status!==0)throw Error('Unable to create the local instance identity');
  fs.chmodSync(key,0o600);fs.chmodSync(cert,0o600);fs.renameSync(key,keyFile);fs.renameSync(cert,certFile);
 }
 fs.chmodSync(keyFile,0o600);fs.chmodSync(certFile,0o600);
 const key=fs.readFileSync(keyFile,'utf8'),cert=fs.readFileSync(certFile,'utf8');
 if(certificatePin(cert).length!==43)throw Error('Invalid local instance identity');return {key,cert};
}
export class InstanceLANServer {
 private server?:https.Server;private identity?:InstanceLANIdentity;
 constructor(private readonly relay:InstanceRelay,private readonly directory:string){}
 async start():Promise<InstanceLANIdentity>{
  if(this.identity)return this.identity;const {key,cert}=credentials(this.directory),pin=certificatePin(cert);
  const server=https.createServer({key,cert,minVersion:'TLSv1.3'},(request,response)=>void this.handle(request,response));
  server.requestTimeout=0;server.headersTimeout=10000;server.maxHeadersCount=32;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'::',()=>{server.off('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string'){server.close();throw Error('Invalid local instance listener');}
  this.server=server;this.identity={publicKey:pin,host:localLANHost(),port:address.port};return this.identity;
 }
 stop(){this.identity=undefined;this.server?.closeAllConnections();this.server?.close();this.server=undefined;}
 private async handle(request:IncomingMessage,response:ServerResponse){
  response.setHeader('cache-control','no-store');response.setHeader('x-content-type-options','nosniff');
  try{
   if(request.method!=='POST'||request.url!=='/v1'||request.headers['content-type']!=='application/json')fail('Local instance route not found',404);
   request.setTimeout(10000,()=>request.destroy());const chunks:Buffer[]=[];let total=0;for await(const chunk of request){total+=chunk.length;if(total>1_048_576)fail('Local request exceeds limit',413);chunks.push(chunk);}
   request.setTimeout(0);const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));let started=false;const controller=new AbortController();request.once('aborted',()=>controller.abort());response.once('close',()=>{if(!response.writableEnded)controller.abort();});
   await this.relay.dispatch(body,async(data,terminal=false,status=200,contentType='application/json')=>{
    if(!started){started=true;response.writeHead(status,{'content-type':contentType,'cache-control':'no-store','x-content-type-options':'nosniff'});}
    response.write(data);if(terminal)response.end();
   },controller.signal);
   if(!response.writableEnded)response.end();
  }catch(error:any){if(!response.headersSent)response.writeHead(error.status??502,{'content-type':'application/json','cache-control':'no-store'});if(!response.writableEnded)response.end(JSON.stringify({error:'Local instance operation refused',status:error.status??502}));}
 }
}
