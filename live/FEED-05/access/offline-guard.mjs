import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => { throw new Error('OFFLINE_NETWORK_FORBIDDEN'); };
globalThis.fetch = denied;
net.connect = net.createConnection = denied;
http.request = http.get = https.request = https.get = denied;
syncBuiltinESMExports();
