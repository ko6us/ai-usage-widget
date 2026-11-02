// Cloudflare Worker. Bind a private KV namespace as USAGE.
// Only hashes of the app's keys are deployed; these are not provider credentials.
const READ_HASH = '__READ_HASH__';
const WRITE_HASH = '__WRITE_HASH__';
const headers = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const reply = (body,status=200) => new Response(JSON.stringify(body),{status,headers});
async function authorized(req, expected) {
  const value = req.headers.get('Authorization') || '';
  if (!value.startsWith('Bearer ') || value.length > 256) return false;
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value.slice(7)));
  const actual = [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
  return /^[a-f0-9]{64}$/.test(expected) && actual === expected;
}
function sanitize(input) {
  if (input?.schemaVersion !== 1 || !input.services) throw Error('schema');
  const services = {};
  for (const name of ['codex','claude']) {
    const s=input.services[name];
    if (!s || !['ok','error','unconfigured'].includes(s.status)) throw Error('status');
    if (s.fetchedAt !== null && (!Number.isInteger(s.fetchedAt) || s.fetchedAt<0 || s.fetchedAt>Date.now()/1000+300)) throw Error('time');
    if (!Array.isArray(s.windows) || s.windows.length>12) throw Error('windows');
    const windows=s.windows.map(w=>{
      if (typeof w.id!=='string' || typeof w.label!=='string' || w.id.length>80 || w.label.length>80) throw Error('label');
      if (!Number.isFinite(w.usedPercent) || w.usedPercent<0 || w.usedPercent>100) throw Error('percent');
      if (w.resetsAt!==null && (!Number.isInteger(w.resetsAt) || w.resetsAt<0)) throw Error('reset');
      return {id:w.id,label:w.label,usedPercent:w.usedPercent,resetsAt:w.resetsAt};
    });
    const errorCode=['auth_required','rate_limited','unavailable','timeout','not_installed','invalid_response'].includes(s.errorCode)?s.errorCode:null;
    services[name]={status:s.status,fetchedAt:s.fetchedAt,windows,errorCode};
  }
  return {schemaVersion:1,receivedAt:Math.floor(Date.now()/1000),services};
}
export {sanitize};
export default {
  async fetch(req,env) {
    const path=new URL(req.url).pathname;
    if (path==='/health' && req.method==='GET') return reply({ok:true});
    if (!['/v1/usage'].includes(path)) return reply({error:'not_found'},404);
    if (!['GET','PUT'].includes(req.method)) return reply({error:'method_not_allowed'},405);
    if (!await authorized(req,req.method==='GET'?READ_HASH:WRITE_HASH)) return reply({error:'unauthorized'},401);
    if (!env.USAGE) return reply({error:'storage_not_configured'},503);
    try {
      if (req.method==='GET') {
        const value=await env.USAGE.get('latest',{type:'json'});
        return value?reply(value):reply({error:'no_data'},404);
      }
      if (!req.headers.get('content-type')?.startsWith('application/json')) return reply({error:'content_type'},415);
      if (Number(req.headers.get('content-length'))>16384) return reply({error:'too_large'},413);
      // Stream with a hard bound even when Content-Length is missing.
      const reader=req.body?.getReader();
      if (!reader) return reply({error:'invalid_payload'},400);
      let size=0; const chunks=[];
      for (;;) {
        const {done,value}=await reader.read(); if(done) break;
        size+=value.byteLength;
        if(size>16384) {await reader.cancel();return reply({error:'too_large'},413);}
        chunks.push(value);
      }
      const bytes=new Uint8Array(size); let offset=0;
      for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      let data;
      try {data=sanitize(JSON.parse(new TextDecoder().decode(bytes)));}
      catch{return reply({error:'invalid_payload'},400);}
      await env.USAGE.put('latest',JSON.stringify(data));
      return reply({ok:true,receivedAt:data.receivedAt});
    } catch {return reply({error:'storage_unavailable'},503);}
  }
};
