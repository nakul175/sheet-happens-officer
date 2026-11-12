import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function renderService(m){
 if(m.schemaVersion!==1||m.nodeMajor!==22||m.platform!=='linux-x64-glibc')throw Error('Unsupported runtime profile');
 for(const v of [m.user,m.group,m.workingDirectory,m.execStart,...m.environmentFiles.map(x=>x.path)])if(/[\r\n]/.test(v))throw Error('Invalid unit value');
 return `[Unit]\nDescription=Sheet Happens Officer\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nUser=${m.user}\nGroup=${m.group}\nWorkingDirectory=${m.workingDirectory}\n${m.environmentFiles.map(f=>`EnvironmentFile=${f.optional?'-':''}${f.path}`).join('\n')}\nEnvironment=NODE_ENV=production\nExecStart=${m.execStart}\nRestart=${m.restart}\nRestartSec=${m.restartSeconds}\nTimeoutStopSec=${m.stopTimeoutSeconds}\nKillSignal=${m.killSignal}\n\n[Install]\nWantedBy=multi-user.target\n`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.stdout.write(renderService(JSON.parse(readFileSync(new URL('./runtime-manifest.json',import.meta.url),'utf8'))));
