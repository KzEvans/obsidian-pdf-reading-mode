import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import type { ReaderBlock, ReaderDocument } from '../src/types';

const pluginClass = build({
  entryPoints:[new URL('../src/main.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node',
  plugins:[{name:'asset-test-api',setup(builder){
    builder.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'test'}));
    builder.onLoad({filter:/.*/,namespace:'test'},()=>({contents:`
      export class Plugin { constructor(app) { this.app=app; } }
      export class App {} export class TFile {} export class FileView {} export class WorkspaceLeaf {}
      export class FileSystemAdapter {} export class Modal {} export class Notice {} export class PluginSettingTab {} export class Setting {}
      export function setIcon() {}
      export async function loadPdfJs() { const h=globalThis.__assetHarness;h.loads++;return h.pdfjs; }
      export async function requestUrl() { throw new Error('Network access is not used by asset tests'); }
    `}));
    builder.onResolve({filter:/^\.\/render$/},()=>({path:'render',namespace:'render-stub'}));
    builder.onLoad({filter:/.*/,namespace:'render-stub'},()=>({contents:`
      export function renderReader() {} export function scrollToSourcePage() {}
      export function getVisibleSourcePage() {} export function createSourcePageTracker() {} export function blockSearchText() { return ''; }
    `}));
  }}],
}).then(async result => (await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0]!.text).toString('base64'))).default);

function pngHeader(width:number,height:number):Buffer {
  const bytes=Buffer.alloc(24);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  bytes.write('IHDR',12,'ascii');bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);
  return bytes;
}

interface CanvasMock {
  width:number;height:number;
  draws:unknown[][];masks:number[][];
  getContext:()=>{drawImage:(...args:unknown[])=>void;fillRect:(...args:number[])=>void;fillStyle:string};
  toBlob:(callback:(blob:Blob|null)=>void,type:string)=>void;
  toDataURL:()=>never;
}

async function harness(blocks:ReaderBlock[],failure?:'encode'|'render') {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pdf-reader-assets-'));
  const counters={loads:0,reads:0,destroyed:0,cleaned:[] as number[],rendered:[] as number[],encoded:0,pdfjs:{} as any};
  const canvases:CanvasMock[]=[];
  counters.pdfjs={getDocument:()=>({promise:Promise.resolve({
    getPage:async(number:number)=>({
      getViewport:({scale}:{scale:number})=>({width:1000*scale,height:800*scale,scale}),
      render:()=>{counters.rendered.push(number);return{promise:failure==='render'?Promise.reject(new Error('Source page render failed')):Promise.resolve()};},
      cleanup:()=>{counters.cleaned.push(number);},
    }),
    destroy:async()=>{counters.destroyed++;},
  })})};
  (globalThis as any).__assetHarness=counters;
  const document={defaultView:{devicePixelRatio:1,setTimeout:(callback:()=>void)=>{queueMicrotask(callback);return 0;}},createElement:(tag:string)=>{
    assert.equal(tag,'canvas');
    const canvas:CanvasMock={width:0,height:0,draws:[],masks:[],
      getContext:()=>({drawImage:(...args)=>{canvas.draws.push(args);},fillRect:(...args)=>{canvas.masks.push(args);},fillStyle:''}),
      toBlob:(callback,type)=>{assert.equal(type,'image/png');counters.encoded++;queueMicrotask(()=>callback(failure==='encode'?null:new Blob([new Uint8Array(pngHeader(canvas.width,canvas.height))])));},
      toDataURL:()=>{throw new Error('Synchronous base64 encoding must not be used');},
    };canvases.push(canvas);return canvas;
  }};
  const app={vault:{readBinary:async()=>{counters.reads++;return new ArrayBuffer(8);}}};
  const Plugin=await pluginClass;const plugin=new Plugin(app);
  const reader:ReaderDocument={schemaVersion:1,sourceHash:'local-test',parserSignature:'test',pageCount:2,warnings:[],blocks};
  const cached={document:reader,directory,contentBase:'.',assets:[] as string[],assetDimensions:undefined as Record<string,{width:number;height:number}>|undefined};
  return{plugin,cached,state:{document,file:{path:'local.pdf'}},counters,canvases,directory};
}

function block(id:string,kind:ReaderBlock['kind'],page=1):ReaderBlock {
  return{id,kind,text:kind==='equation'?'$E = 3$':'',sources:[{page,bbox:[0,0,.5,.5]}],captions:['Selectable source caption $T = 20$.']};
}

test('existing source crops restore assets and persist dimensions without opening the PDF',async()=>{
  const figure=block('figure','figure');const table=block('table','table');
  const h=await harness([figure,table]);
  try {
    for(const [asset,width,height] of [['fallback-v2/figure.png',640,480],['source-tables-v1/table.png',800,300]] as const){
      await fs.mkdir(path.dirname(path.join(h.directory,asset)),{recursive:true});
      await fs.writeFile(path.join(h.directory,asset),pngHeader(width,height));
    }
    await h.plugin.makeFallbackAssets(h.state,h.cached);
    assert.equal(h.counters.loads,0);assert.equal(h.counters.reads,0);assert.equal(h.canvases.length,0);
    assert.equal(figure.asset,'fallback-v2/figure.png');assert.equal(table.asset,'source-tables-v1/table.png');
    assert.deepEqual(h.cached.assetDimensions,{'fallback-v2/figure.png':{width:640,height:480},'source-tables-v1/table.png':{width:800,height:300}});
    const saved=JSON.parse(await fs.readFile(path.join(h.directory,'result.json'),'utf8'));
    assert.deepEqual(saved.assetDimensions,h.cached.assetDimensions);
    await h.plugin.makeFallbackAssets(h.state,h.cached);
    assert.equal(h.counters.loads,0);assert.equal(h.counters.reads,0);
    assert.equal(new Set(h.cached.assets).size,2);
  } finally {await fs.rm(h.directory,{recursive:true,force:true});}
});

test('multiple source crops on one page share the raster and retain captions, source boxes and image dimensions',async()=>{
  const figure=block('figure','figure');figure.sources.push({page:1,bbox:[.1,.4,.4,.5]});
  const table=block('table','table');table.sources[0]!.bbox=[.25,.25,.75,.75];
  const equation=block('equation','equation',2);
  const sourceSnapshot=JSON.stringify([figure,table,equation].map(item=>({sources:item.sources,captions:item.captions,text:item.text})));
  const h=await harness([figure,table,equation]);
  try {
    await h.plugin.makeFallbackAssets(h.state,h.cached);
    assert.deepEqual(h.counters.rendered,[1,2]);assert.equal(h.counters.loads,1);assert.equal(h.counters.reads,1);assert.equal(h.counters.encoded,3);
    assert.deepEqual(h.counters.cleaned,[1,2]);assert.equal(h.counters.destroyed,1);
    const crops=h.canvases.filter(canvas=>canvas.draws.length);
    assert.equal(crops.length,3);assert.equal(crops[0]!.draws[0]![0],crops[1]!.draws[0]![0]);
    assert.notEqual(crops[1]!.draws[0]![0],crops[2]!.draws[0]![0]);
    assert.deepEqual(crops[1]!.draws[0]!.slice(1),[496,400,1008,808,0,0,1008,808]);
    assert.equal(crops[0]!.masks.length,1);assert.equal(crops[1]!.masks.length,0);
    assert.equal(JSON.stringify([figure,table,equation].map(item=>({sources:item.sources,captions:item.captions,text:item.text}))),sourceSnapshot);
    for(const item of [figure,table,equation]){
      assert.ok(item.asset);const bytes=await fs.readFile(path.join(h.directory,item.asset));
      assert.deepEqual(h.cached.assetDimensions![item.asset],{width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)});
    }
    assert.ok(h.canvases.every(canvas=>canvas.width===0&&canvas.height===0));
    const saved=JSON.parse(await fs.readFile(path.join(h.directory,'result.json'),'utf8'));
    assert.deepEqual(saved.assetDimensions,h.cached.assetDimensions);
  } finally {await fs.rm(h.directory,{recursive:true,force:true});}
});

test('failed source rendering or encoding releases the PDF raster and leaves an unfinished asset unassigned',async()=>{
  for(const failure of ['render','encode'] as const){
    const figure=block('figure','figure');const h=await harness([figure],failure);
    try {
      await assert.rejects(h.plugin.makeFallbackAssets(h.state,h.cached),failure==='render'?/Source page render failed/:/原文图表生成失败/);
      assert.equal(h.counters.destroyed,1);assert.deepEqual(h.counters.cleaned,[1]);
      assert.ok(h.canvases.every(canvas=>canvas.width===0&&canvas.height===0));
      assert.equal(figure.asset,undefined);assert.deepEqual(h.cached.assets,[]);
      await assert.rejects(fs.access(path.join(h.directory,'result.json')),/ENOENT/);
    } finally {await fs.rm(h.directory,{recursive:true,force:true});}
  }
});
