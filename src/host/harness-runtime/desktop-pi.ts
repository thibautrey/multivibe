import { callDesktop, DESKTOP_TOOLS } from "./desktop-tools.js";

/** Pi's native extension API has no built-in MCP transport. Expose the same schemas
 * and results without changing its global configuration or its own tool loop. */
export default function desktopExtension(pi:any) {
  const socket=process.env.MULTIVIBE_DESKTOP_SOCKET,token=process.env.MULTIVIBE_DESKTOP_TOKEN;
  if(!socket || !token)return;
  for(const tool of DESKTOP_TOOLS)pi.registerTool({
    name:`multivibe_${tool.name}`,label:`Host ${tool.name}`,description:tool.description,parameters:tool.inputSchema,
    execute:async(_id:string,args:unknown,signal?:AbortSignal)=>{
      const result=await callDesktop({socket,token},tool.name,args,signal);
      if(result.isError)throw new Error(result.content.filter(c=>c.type==="text").map(c=>c.text).join("\n"));
      return {...result,details:{provider:"multivibe-host",isError:false}};
    },
  });
}
