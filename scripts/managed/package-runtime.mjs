import { readFile, mkdir, copyFile, writeFile } from "node:fs/promises";
import { resolve, dirname, relative, sep } from "node:path";
import ts from "typescript";

const sourceRoot = resolve("dist");
const outputRoot = resolve(process.argv[2] ?? "managed-dist");
if (outputRoot === sourceRoot || outputRoot.startsWith(sourceRoot + sep)) throw Error("Managed output must be separate from dist");
const queue = [resolve(sourceRoot,"managed/main.js")];
const visited = new Set();
while(queue.length) {
  const file=queue.pop();
  if(visited.has(file))continue;
  if(!file.startsWith(sourceRoot+sep))throw Error("Managed runtime import escapes dist");
  const text=await readFile(file,"utf8");
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
  await copyFile(file,destination);
}
await writeFile(resolve(outputRoot,"package.json"),JSON.stringify({type:"module",private:true}));
await writeFile(resolve(outputRoot,"runtime-files.json"),JSON.stringify([...visited].map(file=>relative(sourceRoot,file)).sort(),null,2));
process.stdout.write(`Packaged ${visited.size} managed runtime modules; no npm runtime dependencies\n`);
