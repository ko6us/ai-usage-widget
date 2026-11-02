import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto,createHash} from 'node:crypto';
if(!globalThis.crypto)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const keyR='r'.repeat(43),keyW='w'.repeat(43);
const hash=x=>createHash('sha256').update(x).digest('hex');
const source=(await readFile(new URL('../cloudflare/worker.mjs',import.meta.url),'utf8')).replace('__READ_HASH__',hash(keyR)).replace('__WRITE_HASH__',hash(keyW));
const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const store=new Map();
const env={USAGE:{get:async k=>store.has(k)?JSON.parse(store.get(k)):null,put:async(k,v)=>store.set(k,v)}};
const sample=()=>({schemaVersion:1,services:{codex:{status:'ok',fetchedAt:1,windows:[{id:'codex:primary',label:'5時間',usedPercent:20,resetsAt:123}]},claude:{status:'error',fetchedAt:null,windows:[],errorCode:'auth_required'}}});
const request=(method,key,body)=>new Request('https://example.com/v1/usage',{method,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
test('unauthenticated and wrong-scope access is refused',async()=>{
  assert.equal((await worker.fetch(request('GET','bad'),env)).status,401);
  assert.equal((await worker.fetch(request('PUT',keyR,sample()),env)).status,401);
  assert.equal((await worker.fetch(request('GET',keyW),env)).status,401);
});
test('upload strips unrelated sensitive fields and authenticated read returns quota',async()=>{
  const input=sample();input.accessToken='secret';input.services.codex.email='private';
  assert.equal((await worker.fetch(request('PUT',keyW,input),env)).status,200);
  const response=await worker.fetch(request('GET',keyR),env);
  assert.equal(response.status,200);
  const body=await response.text();assert.ok(!body.includes('secret'));assert.ok(!body.includes('private'));
  assert.equal(JSON.parse(body).services.codex.windows[0].usedPercent,20);
});
test('invalid percent is rejected without overwriting latest',async()=>{
  const before=store.get('latest'); const input=sample();input.services.codex.windows[0].usedPercent=101;
  assert.equal((await worker.fetch(request('PUT',keyW,input),env)).status,400);
  assert.equal(store.get('latest'),before);
});
test('oversized body is rejected',async()=>{
  assert.equal((await worker.fetch(request('PUT',keyW,{padding:'x'.repeat(20000)}),env)).status,413);
});
test('storage outage is reported without leaking exceptions',async()=>{
  const broken={USAGE:{get:async()=>{throw Error('sensitive internal detail')}}};
  const res=await worker.fetch(request('GET',keyR),broken);
  assert.equal(res.status,503);assert.ok(!(await res.text()).includes('sensitive'));
});
