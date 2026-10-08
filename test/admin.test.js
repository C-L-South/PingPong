const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const root = path.join(__dirname, '..');
const seed = { version: 1, customMetadata: 'retain', accounts: [{id:'101',name:'Existing Member',username:'member',password:'legacy-password',createdAt:'2025-01-01'}], players: [{id:'101',accountId:'101',name:'Existing Member',username:'member',elo:1040,wins:3,losses:1},{id:'102',accountId:null,name:'Other Player',username:null,elo:960,wins:1,losses:3}], matches: [{id:7,winnerId:'101',loserId:'102',winnerName:'Existing Member',loserName:'Other Player',score:'11-8',eloApplied:true,winnerChange:16,loserChange:16,confirmations:{101:true,102:true},date:'2025-01-01'}] };
const credentials = { ADMIN_USERNAME:'club-admin', ADMIN_PASSWORD:crypto.randomBytes(24).toString('hex'), ADMIN_SESSION_SECRET:crypto.randomBytes(32).toString('hex') };
async function start(dir) {
  const probe = http.createServer(); probe.listen(0,'127.0.0.1'); await once(probe,'listening'); const port=probe.address().port; await new Promise(r=>probe.close(r));
  const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,...credentials,PORT:String(port),DATA_DIR:dir,DATABASE_URL:'',KV_REST_API_URL:'',KV_REST_API_TOKEN:'',UPSTASH_REDIS_REST_URL:'',UPSTASH_REDIS_REST_TOKEN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Startup timeout')),5000);child.stdout.on('data',d=>{if(d.toString().includes('Server Running')){clearTimeout(timeout);resolve();}});child.on('exit',code=>{clearTimeout(timeout);reject(new Error(`Server exited ${code}`));});});
  return {base:`http://127.0.0.1:${port}`,child};
}
async function request(base, route, body, cookie) {
  const res=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:res.status,cookie:res.headers.get('set-cookie')?.split(';')[0],body:await res.json()};
}
async function stop(child) { const done=once(child,'exit');child.kill();await done; }
test('server admin workflow preserves records, rejects unauthenticated writes, and persists across restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'carroll-admin-test-')); const file=path.join(dir,'db.json');fs.writeFileSync(file,JSON.stringify(seed));
 let running=await start(dir);
 try {
  const {base}=running;
  assert.equal((await request(base,'/api/admin/players',{name:'Guest'})).status,401);
  assert.equal((await request(base,'/api/admin/matches',{role:'admin',reporterId:'101'})).status,401);
  assert.equal((await request(base,'/api/admin/login',{username:credentials.ADMIN_USERNAME,password:'wrong'})).status,401);
  const login=await request(base,'/api/admin/login',{username:credentials.ADMIN_USERNAME,password:credentials.ADMIN_PASSWORD});assert.equal(login.status,200);assert.ok(login.cookie);
  const cookie=login.cookie;
  assert.equal((await request(base,'/api/admin/session',undefined,cookie)).body.admin.role,'admin');
  assert.equal((await request(base,'/api/admin/players',{name:'Guest'},cookie+'tampered')).status,401);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)),seed);
  const added=await request(base,'/api/admin/players',{name:'Guest Player'},cookie);assert.equal(added.status,201);const id=added.body.player.id;
  assert.equal((await request(base,'/api/admin/players',{name:' guest player '},cookie)).status,409);
  const body={winnerId:'101',loserId:id,winnerScore:11,loserScore:8,requestId:'test-official-1'};
  assert.equal((await request(base,'/api/admin/matches',{...body,loserId:'101'},cookie)).status,400);
  assert.equal((await request(base,'/api/admin/matches',{...body,winnerScore:4},cookie)).status,400);
  const official=await request(base,'/api/admin/matches',body,cookie);assert.equal(official.status,201);assert.equal(official.body.match.verification,'admin');assert.equal(official.body.match.eloApplied,true);
  assert.deepEqual((await request(base,'/api/admin/matches',body,cookie)).body.match,official.body.match);
  const saved=JSON.parse(fs.readFileSync(file));assert.deepEqual(saved.accounts,seed.accounts);assert.deepEqual(saved.matches[0],seed.matches[0]);assert.deepEqual(saved.players[1],seed.players[1]);assert.equal(saved.customMetadata,'retain');assert.equal(saved.matches.length,2);assert.equal(saved.players.length,3);assert.equal(saved.players[0].wins,4);assert.equal(saved.players[2].accountId,null);
  assert.equal((await request(base,'/api/reset',{})).status,403);assert.equal((await request(base,'/api/restore',{data:{players:[]}})).status,403);assert.equal((await request(base,'/api/sync',{players:[]})).status,403);
  assert.equal((await fetch(base+'/data/db.json')).status,404);assert.equal((await request(base,'/api/backup')).status,401);
  assert.equal((await request(base,`/api/matches/${official.body.match.id}/reject`,{userId:'101'})).status,403);
  assert.equal((await request(base,'/api/auth/login',{username:'member',password:'legacy-password'})).status,200);
  await stop(running.child);running=await start(dir);assert.deepEqual(JSON.parse(fs.readFileSync(file)),saved);
 } finally {if(running.child.exitCode===null)await stop(running.child);fs.rmSync(dir,{recursive:true,force:true});}
});

test('serverless admin uses the existing KV key and detects concurrent storage changes',async()=>{
 Object.assign(process.env,credentials,{KV_REST_API_URL:'https://kv.test',KV_REST_API_TOKEN:'test-token'});
 const originalFetch=global.fetch;let raw=JSON.stringify(seed);let conflict=false;let unavailable=false;
 global.fetch=async(url,options={})=>{
  if(unavailable)return new Response(JSON.stringify({error:'unavailable'}),{status:503});
  if(url==='https://kv.test/get/carroll_pingpong_db')return new Response(JSON.stringify({result:raw}));
  assert.equal(url,'https://kv.test');const command=JSON.parse(options.body);assert.equal(command[0],'EVAL');assert.equal(command[3],'carroll_pingpong_db');
  if(conflict||command[4]!==raw)return new Response(JSON.stringify({result:0}));raw=command[5];return new Response(JSON.stringify({result:1}));
 };
 const handler=require('../api/index');
 async function invoke(route,body,cookie){let status,headers={},payload;const req={url:route,method:body===undefined?'GET':'POST',headers:{host:'club.test','content-type':'application/json',cookie},body,socket:{remoteAddress:'test'}};const res={setHeader:(k,v)=>headers[k]=v,writeHead:(code,h)=>{status=code;Object.assign(headers,h);},end:text=>payload=JSON.parse(text)};await handler(req,res);return {status,headers,body:payload};}
 try{
  const login=await invoke('/api/admin/login',{username:credentials.ADMIN_USERNAME,password:credentials.ADMIN_PASSWORD});assert.equal(login.status,200);const cookie=login.headers['Set-Cookie'].split(';')[0];
  assert.equal((await invoke('/api/admin/players',{name:'Serverless Guest'},cookie)).status,201);const saved=JSON.parse(raw);assert.deepEqual(saved.accounts,seed.accounts);assert.deepEqual(saved.matches,seed.matches);assert.deepEqual(saved.players.slice(0,2),seed.players);
  const before=raw;conflict=true;assert.equal((await invoke('/api/admin/players',{name:'Conflict Guest'},cookie)).status,409);assert.equal(raw,before);
  conflict=false;unavailable=true;assert.equal((await invoke('/api/admin/players',{name:'Offline Guest'},cookie)).status,503);assert.equal(raw,before);
 }finally{global.fetch=originalFetch;delete process.env.KV_REST_API_URL;delete process.env.KV_REST_API_TOKEN;}
});
