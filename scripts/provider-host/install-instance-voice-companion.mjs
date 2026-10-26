import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const INSTANCE_VOICE_LABEL='cloud.multivibe.instance-voice';
const escape=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');

export function renderInstanceVoicePlist({node,main,dataDir,stdout,stderr}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${INSTANCE_VOICE_LABEL}</string>
<key>ProgramArguments</key><array><string>${escape(node)}</string><string>${escape(main)}</string></array>
<key>EnvironmentVariables</key><dict><key>MULTIVIBE_HOST_DATA_DIR</key><string>${escape(dataDir)}</string><key>NODE_ENV</key><string>production</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer><key>ExitTimeOut</key><integer>15</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${escape(stdout)}</string>
<key>StandardErrorPath</key><string>${escape(stderr)}</string>
</dict></plist>\n`;
}

function atomic(file,data,mode) {
  const temporary=file+'.'+process.pid+'.tmp';fs.writeFileSync(temporary,data,{mode});fs.renameSync(temporary,file);fs.chmodSync(file,mode);
}

export function stageInstanceVoiceCompanion(options={}) {
  const repository=options.repository??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  const home=options.home??os.homedir();
  const dataDir=options.dataDir??path.join(home,'Library/Application Support/MultiVibe');
  const source=options.source??path.join(repository,'dist/host');
  const destination=options.destination??path.join(dataDir,'instance-voice-companion');
  const launchAgents=options.launchAgents??path.join(home,'Library/LaunchAgents');
  const logs=options.logs??path.join(home,'Library/Logs/MultiVibe');
  const node=options.node??'/Applications/MultiVibe Host.app/Contents/Frameworks/node';
  if(!fs.statSync(node).isFile())throw Error('Installed MultiVibe Host Node runtime is unavailable');
  const names=['instance-voice-main.js','instance-voice.js','instance-voice-audio.js'];
  for(const name of names){const file=path.join(source,name);if(!fs.statSync(file).isFile()||fs.statSync(file).size>1024*1024)throw Error('Build the bounded instance voice companion first');}
  for(const folder of [destination,launchAgents,logs])fs.mkdirSync(folder,{recursive:true,mode:0o700});
  for(const name of names)atomic(path.join(destination,name),fs.readFileSync(path.join(source,name)),0o600);
  atomic(path.join(destination,'package.json'),JSON.stringify({private:true,type:'module'})+'\n',0o600);
  const main=path.join(destination,'instance-voice-main.js'),plist=path.join(launchAgents,INSTANCE_VOICE_LABEL+'.plist');
  atomic(plist,renderInstanceVoicePlist({node,main,dataDir,stdout:path.join(logs,'instance-voice.log'),stderr:path.join(logs,'instance-voice-error.log')}),0o600);
  return {label:INSTANCE_VOICE_LABEL,plist,main};
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href)console.log(JSON.stringify(stageInstanceVoiceCompanion()));
