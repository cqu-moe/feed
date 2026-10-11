import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {cp,mkdir} from 'node:fs/promises';
const require=createRequire(import.meta.url),source=dirname(require.resolve('pdfjs-dist/package.json'));
await mkdir('dist/pdfjs',{recursive:true});
for(const dir of ['cmaps','standard_fonts','wasm'])await cp(join(source,dir),join('dist/pdfjs',dir),{recursive:true});
await cp(join(source,'LICENSE'),'dist/pdfjs/LICENSE');
