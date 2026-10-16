import { register, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import child from 'node:child_process';

const deny = () => { throw new Error('CONTROL_NETWORK_OR_PROCESS_FORBIDDEN'); };
globalThis.fetch = deny;
net.Socket.prototype.connect = net.connect = net.createConnection = deny;
http.request = http.get = https.request = https.get = deny;
child.spawn = child.spawnSync = child.exec = child.execSync = child.execFile = child.fork = deny;
const git = child.execFileSync;
child.execFileSync = (file, args, options) => {
  if (file !== 'git' || !['merge-base', 'diff', 'ls-files'].includes(args[0])) return deny();
  return git(file, args, options);
};
for (const object of [fs, fsp]) for (const method of ['readFile', 'readFileSync', 'open', 'openSync']) {
  if (!object[method]) continue;
  const original = object[method];
  object[method] = (path, ...args) => {
    if (/\/(?:private|\.private)\//.test(String(path))) throw new Error('CONTROL_PRIVATE_READ_FORBIDDEN');
    return original.call(object, path, ...args);
  };
}
syncBuiltinESMExports();
register('./loader.mjs', import.meta.url);
