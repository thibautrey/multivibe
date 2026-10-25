import { spawn } from "node:child_process";
import { JsonPeer } from "./process.js";
import { fail, type HarnessTarget } from "./types.js";

const quote=(value:string)=>`'${value.replace(/'/gu,"'\\''")}'`;
export class RemoteHarnessHosts {
  private peers=new Map<string,JsonPeer>();
  async request(target:HarnessTarget,method:string,route:string,body?:unknown):Promise<any> {
    if(!target.bridgePath || !(target.kind==="ssh" && target.sshHost || target.kind==="container" && target.container))fail("Invalid remote target");
    if(!route.startsWith("/") || route.includes("..") || !["GET","POST","PATCH","DELETE"].includes(method))fail("Invalid remote request");
    let peer=this.peers.get(target.id);
    if(!peer) {
      // The bridge path is shell quoted; SSH options and host names are validated at registration.
      const child=target.kind==="ssh"?spawn("ssh",["-T","-o","BatchMode=yes","-o","StrictHostKeyChecking=yes","-o","ConnectTimeout=15","-o","ServerAliveInterval=15","-o","ServerAliveCountMax=3","--",target.sshHost!,`node -- ${quote(target.bridgePath)}`],{stdio:"pipe",windowsHide:true}):spawn("docker",["exec","-i",target.container!,"node","--",target.bridgePath],{stdio:"pipe",windowsHide:true});
      peer=new JsonPeer(child,()=>{},async()=>fail("Unexpected remote request",422),()=>this.peers.delete(target.id),()=>{},true,32*1024*1024);
      this.peers.set(target.id,peer);
    }
    const result=await peer.request("request",{method,route,...(body!==undefined?{body}:{})},90_000);
    if(result.status>=400)fail(result.body?.error??`Remote Host HTTP ${result.status}`,result.status);
    return result.body;
  }
  close(){for(const peer of this.peers.values())peer.close();this.peers.clear();}
}
