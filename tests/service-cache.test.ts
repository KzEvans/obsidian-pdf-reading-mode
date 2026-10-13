import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import type { App, TFile } from 'obsidian';
import type { CachedReader } from '../src/service';

interface Deferred { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
function deferred(): Deferred {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise=new Promise<void>((done,failed)=>{resolve=done;reject=failed;});
  return {promise,resolve,reject};
}
interface Harness {
  files: Map<string, TFile>;
  bytes: Map<string, Uint8Array>;
  saved: Map<string, CachedReader>;
  gates: Deferred[];
  binaryReads: number;
  hashes: number;
  resultReads: number;
  pdfLoads: number;
  requests: number;
  tokens: number;
  readResult: (filename: string) => Promise<string>;
}
const shared=globalThis as typeof globalThis & { __readerServiceHarness: Harness };
const serviceModule=build({
  entryPoints:[new URL('../src/service.ts',import.meta.url).pathname],
  bundle:true,write:false,format:'esm',platform:'node',target:'es2021',
  plugins:[{
    name:'reader-service-cache-fixture',
    setup(builder){
      builder.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'reader-test'}));
      builder.onResolve({filter:/^node:fs$/},()=>({path:'fs',namespace:'reader-test'}));
      builder.onResolve({filter:/^node:crypto$/},args=>args.namespace==='reader-crypto'
        ? {path:args.path,external:true} : {path:'crypto',namespace:'reader-crypto'});
      builder.onLoad({filter:/.*/,namespace:'reader-crypto'},()=>({contents:`
        import { createHash as nativeHash } from 'node:crypto';
        export function createHash(algorithm) {
          globalThis.__readerServiceHarness.hashes++;
          return nativeHash(algorithm);
        }
      `}));
      builder.onLoad({filter:/.*/,namespace:'reader-test'},args=>({contents:args.path==='fs' ? `
        export const promises = {
          readFile: (filename) => globalThis.__readerServiceHarness.readResult(filename),
        };
      ` : `
        export async function loadPdfJs() {
          globalThis.__readerServiceHarness.pdfLoads++;
          throw new Error('Cached reading must not reopen the PDF parser');
        }
        export async function requestUrl() {
          globalThis.__readerServiceHarness.requests++;
          throw new Error('Cached reading must not use the network');
        }
      `}));
    },
  }],
}).then(async result=>await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`) as typeof import('../src/service'));

async function fixture() {
  const {ReaderService,CACHE_SIGNATURE}=await serviceModule;
  const harness:Harness={files:new Map(),bytes:new Map(),saved:new Map(),gates:[],binaryReads:0,hashes:0,resultReads:0,pdfLoads:0,requests:0,tokens:0,
    readResult:async filename=>{
      harness.resultReads++;
      const hash=filename.match(/\/([a-f0-9]{64})-vlm-v1\/result\.json$/)?.[1];
      const result=hash&&harness.saved.get(hash);
      if(!result)throw new Error('Unexpected cache lookup: '+filename);
      return JSON.stringify(result);
    },
  };
  shared.__readerServiceHarness=harness;
  const app={vault:{getAbstractFileByPath:(filename:string)=>harness.files.get(filename)??null,readBinary:async(file:TFile)=>{
    harness.binaryReads++;
    const bytes=new Uint8Array(harness.bytes.get(file.path)!);
    const gate=harness.gates.shift();
    if(gate)await gate.promise;
    return bytes.buffer;
  }}} as unknown as App;
  const service=new ReaderService(app,'/vault/.obsidian/plugins/pdf-reading-mode',()=>{harness.tokens++;return null;});
  function setBytes(file:TFile, values:number[]) {
    harness.files.set(file.path,file);
    const bytes=new Uint8Array(values);
    harness.bytes.set(file.path,bytes);
    const hash=createHash('sha256').update(bytes).digest('hex');
    harness.saved.set(hash,{directory:'/previous/cache/path',contentBase:'.',assets:[],
      document:{schemaVersion:1,sourceHash:hash,parserSignature:CACHE_SIGNATURE,pageCount:1,blocks:[],warnings:[]},
    });
    return hash;
  }
  function paper(filename='paper.pdf',values=[1,2,3]) {
    const file={path:filename,stat:{ctime:1,mtime:1,size:values.length}} as TFile;
    setBytes(file,values);
    return file;
  }
  return {service,harness,paper,setBytes};
}

test('reopening an unchanged cached PDF does no further file reads or hashes and shares image metadata',async()=>{
  const {service,harness,paper}=await fixture();
  const file=paper();
  const first=await service.getDocument(file,()=>{});
  first.assetDimensions={'figure.png':{width:700,height:400}};
  for(let index=0;index<10;index++) {
    const next=await service.getDocument(file,()=>{});
    assert.equal(next,first);
    assert.deepEqual(next.assetDimensions,{'figure.png':{width:700,height:400}});
  }
  assert.deepEqual([harness.binaryReads,harness.hashes,harness.resultReads],[1,1,1]);
  assert.deepEqual([harness.pdfLoads,harness.requests,harness.tokens],[0,0,0]);
});

test('simultaneous tabs share the PDF read, hash and cache load before the first read completes',async()=>{
  const {service,harness,paper}=await fixture();
  const file=paper(),gate=deferred();
  harness.gates.push(gate);
  const firstStatus:string[]=[],secondStatus:string[]=[];
  const first=service.getDocument(file,message=>firstStatus.push(message));
  const second=service.getDocument(file,message=>secondStatus.push(message));
  await Promise.resolve();
  assert.deepEqual([harness.binaryReads,harness.hashes],[1,0]);
  gate.resolve();
  const [a,b]=await Promise.all([first,second]);
  assert.equal(a,b);
  assert.deepEqual([harness.binaryReads,harness.hashes,harness.resultReads],[1,1,1]);
  assert.ok(firstStatus.includes('已载入离线阅读缓存'));
  assert.ok(secondStatus.includes('已载入离线阅读缓存'));
});

test('mtime and size each invalidate memory results and recheck the content hash',async()=>{
  const {service,harness,paper,setBytes}=await fixture();
  const file=paper();
  const first=await service.getDocument(file,()=>{});
  file.stat.mtime++;
  const secondHash=setBytes(file,[3,2,1]);
  const second=await service.getDocument(file,()=>{});
  assert.notEqual(second,first);
  assert.equal(second.document.sourceHash,secondHash);
  file.stat.size=4;
  const thirdHash=setBytes(file,[3,2,1,0]);
  const third=await service.getDocument(file,()=>{});
  assert.equal(third.document.sourceHash,thirdHash);
  assert.deepEqual([harness.binaryReads,harness.hashes,harness.resultReads],[3,3,3]);
});

test('an older in-flight file version cannot overwrite a newer completed memory result',async()=>{
  const {service,harness,paper,setBytes}=await fixture();
  const file=paper(),gate=deferred();
  harness.gates.push(gate);
  const older=service.getDocument(file,()=>{});
  await Promise.resolve();
  file.stat.mtime++;
  const newHash=setBytes(file,[3,2,1]);
  const current=await service.getDocument(file,()=>{});
  gate.resolve();
  const previous=await older;
  assert.notEqual(previous.document.sourceHash,newHash);
  const reopened=await service.getDocument(file,()=>{});
  assert.equal(reopened,current);
  assert.equal(reopened.document.sourceHash,newHash);
  assert.deepEqual([harness.binaryReads,harness.hashes,harness.resultReads],[2,2,2]);
});

test('a failed shared read is removed so a later open can retry normally',async()=>{
  const {service,harness,paper}=await fixture();
  const file=paper(),gate=deferred();
  harness.gates.push(gate);
  const opens=[service.getDocument(file,()=>{}),service.getDocument(file,()=>{})];
  const settled=Promise.allSettled(opens);
  await Promise.resolve();
  gate.reject(new Error('Temporary read failure'));
  assert.ok((await settled).every(result=>result.status==='rejected'));
  await service.getDocument(file,()=>{});
  assert.deepEqual([harness.binaryReads,harness.hashes,harness.resultReads],[2,1,1]);
});

test('replacing a vault file object while loading also prevents the old version from replacing its cache',async()=>{
  const {service,harness,paper,setBytes}=await fixture();
  const oldFile=paper(),gate=deferred();
  harness.gates.push(gate);
  const pending=service.getDocument(oldFile,()=>{});
  await Promise.resolve();
  const newFile={path:oldFile.path,stat:{...oldFile.stat,mtime:2}} as TFile;
  setBytes(newFile,[3,2,1]);
  const current=await service.getDocument(newFile,()=>{});
  gate.resolve();
  await pending;
  assert.equal(await service.getDocument(newFile,()=>{}),current);
  assert.deepEqual([harness.binaryReads,harness.hashes,harness.resultReads],[2,2,2]);
});

test('different file paths with identical bytes still share the hash-level processing task',async()=>{
  const {service,harness,paper}=await fixture();
  const first=paper('paper.pdf'),second=paper('copy.pdf');
  const [a,b]=await Promise.all([service.getDocument(first,()=>{}),service.getDocument(second,()=>{})]);
  assert.equal(a,b);
  assert.deepEqual([harness.binaryReads,harness.hashes,harness.resultReads],[2,2,1]);
});

test('completed document memory is bounded while recently opened papers stay reusable',async()=>{
  const {service,harness,paper}=await fixture();
  const files=Array.from({length:9},(_,index)=>paper('paper-'+index+'.pdf',[index,2,3]));
  const first=await service.getDocument(files[0]!,()=>{});
  let latest!:CachedReader;
  for(const file of files.slice(1))latest=await service.getDocument(file,()=>{});
  assert.equal(await service.getDocument(files[8]!,()=>{}),latest);
  assert.equal(harness.binaryReads,9);
  assert.notEqual(await service.getDocument(files[0]!,()=>{}),first);
  assert.equal(harness.binaryReads,10);
});

test('stopping the service prevents reuse and clears queued status callbacks',async()=>{
  const {service,harness,paper}=await fixture();
  const file=paper(),gate=deferred(),status:string[]=[];
  harness.gates.push(gate);
  const opening=service.getDocument(file,message=>status.push(message));
  await Promise.resolve();
  service.stop();
  gate.resolve();
  await opening;
  assert.deepEqual(status,[]);
  await assert.rejects(service.getDocument(file,()=>{}),/插件已关闭/);
});
