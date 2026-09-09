import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname, relative, sep } from "node:path";
import ts from "typescript";
import {build} from "esbuild";

const sourceRoot = resolve("dist");
const outputRoot = resolve(process.argv[2] ?? "managed-dist");
if (outputRoot === sourceRoot || outputRoot.startsWith(sourceRoot + sep)) throw Error("Managed output must be separate from dist");
await mkdir(outputRoot, { recursive: false });
const entry = process.argv[3] ?? "core";
if (!["core", "injector"].includes(entry)) throw Error("Unknown managed package entry");
const queue = [resolve(sourceRoot,entry === "injector" ? "managed/injector-main.js" : "managed/main.js")];
const visited = new Set();
while(queue.length) {
  const file=queue.pop();
  if(visited.has(file))continue;
  if(!file.startsWith(sourceRoot+sep))throw Error("Managed runtime import escapes dist");
  let text=await readFile(file,"utf8");
  if(relative(sourceRoot,file)==="managed/native-anthropic.js") {
    if(entry!=="injector")throw Error("Native credential codec cannot enter Core package");
    const bundle=await build({entryPoints:[file],bundle:true,write:false,format:"esm",platform:"node",target:"node22",metafile:true});
    // Only this reviewed codec and its pinned schema/SDK dependencies can be bundled.
    const allowed=new Set(["@ai-sdk/anthropic","@ai-sdk/provider","@ai-sdk/provider-utils","@workflow/serde","@standard-schema/spec","@standard-schema/utils","eventsource-parser","secure-json-parse","zod"]);
    for(const input of Object.keys(bundle.metafile.inputs)) {
      const match=input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
      if(match&&!allowed.has(match[1]))throw Error(`Unreviewed native codec dependency ${match[1]}`);
      if(!match&&!['dist/managed/native-anthropic.js','dist/ai-sdk/anthropic-model.js','dist/ai-sdk/protocol.js'].includes(input))throw Error(`Unreviewed native codec source ${input}`);
    }
    text=bundle.outputFiles[0].text;
    await writeFile(resolve(outputRoot,"native-codec-inputs.json"),JSON.stringify(Object.keys(bundle.metafile.inputs).sort(),null,2));
  }
  const parsed=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const dependencies=[];
  function visit(node) {
    if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier) {
      if(!ts.isStringLiteral(node.moduleSpecifier))throw Error("Managed runtime has a computed module");
      dependencies.push(node.moduleSpecifier.text);
    }
    if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword) {
      if(node.arguments.length!==1||!ts.isStringLiteral(node.arguments[0]))throw Error("Managed runtime has a dynamic import");
      dependencies.push(node.arguments[0].text);
    }
    ts.forEachChild(node,visit);
  }
  visit(parsed);
  for(const dependency of dependencies) {
    if(dependency.startsWith("node:"))continue;
    if(!dependency.startsWith("."))throw Error(`Managed runtime requires unreviewed package ${dependency}`);
    queue.push(resolve(dirname(file),dependency));
  }
  visited.add(file);
  const destination=resolve(outputRoot,relative(sourceRoot,file));
  await mkdir(dirname(destination),{recursive:true});
  await writeFile(destination,text);
}
await writeFile(resolve(outputRoot,"package.json"),JSON.stringify({type:"module",private:true}));
await writeFile(resolve(outputRoot,"runtime-files.json"),JSON.stringify([...visited].map(file=>relative(sourceRoot,file)).sort(),null,2));
process.stdout.write(`Packaged ${visited.size} managed runtime modules; no npm runtime dependencies\n`);
