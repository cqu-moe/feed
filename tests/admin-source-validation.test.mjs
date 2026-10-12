import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const sourcePath=fileURLToPath(new URL('../src/admin-source-validation.ts',import.meta.url));
const compiled=await build({entryPoints:[sourcePath],format:'esm',platform:'node',write:false});
const compiledPath=path.join(await mkdtemp(path.join(tmpdir(),'feed-admin-validation-')),'admin-source-validation.mjs');
await writeFile(compiledPath,compiled.outputFiles[0].text);
const {readValidationSnapshot}=await import(pathToFileURL(compiledPath).href);
await rm(path.dirname(compiledPath),{recursive:true,force:true});

test('a terminal validation snapshot refetches the source after a concurrent draft read',async()=>{
  const sources=[
    {id:'source',configVersion:3,validationState:'draft'},
    {id:'source',configVersion:3,validationState:'verified'},
  ];
  let reads=0;
  const snapshot=await readValidationSnapshot(
    async()=>sources[reads++],
    async()=>({state:'succeeded'}),
  );
  assert.equal(snapshot.source.validationState,'verified');
  assert.equal(snapshot.task.state,'succeeded');
  assert.equal(reads,2);
});

test('a stale terminal task and a still-draft source stop after one source refresh',async()=>{
  const sources=[
    {id:'source',configVersion:3,validationState:'draft'},
    {id:'source',configVersion:3,validationState:'draft'},
  ];
  let reads=0;
  const snapshot=await readValidationSnapshot(
    async()=>sources[reads++],
    async()=>({state:'succeeded'}),
  );
  assert.equal(snapshot.source.validationState,'draft');
  assert.equal(reads,2);
});
