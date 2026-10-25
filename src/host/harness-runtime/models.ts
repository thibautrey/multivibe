export type HarnessModel = { id:string; name:string; provider?:string; description?:string; isDefault?:boolean };
export function harnessModels(value:any):HarnessModel[] {
  let rows:any[]=Array.isArray(value)?value:Array.isArray(value?.data)?value.data:Array.isArray(value?.models)?value.models:value?.models?.availableModels??[];
  const modelConfig=value?.configOptions?.find((v:any)=>v.category==="model" || v.id==="model");
  if(!rows.length && modelConfig)rows=(modelConfig.options??[]).flatMap((v:any)=>Array.isArray(v.options)?v.options:[v]);
  const options:HarnessModel[]=rows.flatMap(row=>{
    const id=row?.model??row?.modelId??row?.id??row?.value;
    if(typeof id!=="string" || !id || id.length>256)return [];
    return [{id,name:row.displayName??row.name??row.label??id,...(typeof row.provider==="string"?{provider:row.provider}:{}),...(typeof row.description==="string"?{description:row.description}:{}),...(row.isDefault===true?{isDefault:true}:{})}];
  });
  const connected=Array.isArray(value?.connected)?new Set(value.connected):undefined;
  for(const provider of value?.all??[]) {
    if(typeof provider.id!=="string" || connected && !connected.has(provider.id))continue;
    for(const [id,model] of Object.entries(provider.models??{}) as [string,any][])options.push({id:provider.id+"/"+id,name:model.name??id,description:provider.name??provider.id});
  }
  return [...new Map(options.map(v=>[JSON.stringify([v.provider,v.id]),v])).values()];
}
