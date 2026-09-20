import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WebsiteStore, hash, SESSION_TTL } from '../src/server/website-store.ts';
import { websiteRequest } from '../src/server/website-http.ts';
function fixture() {
  const db = new DatabaseSync(':memory:');
  const store = new WebsiteStore({ exec(query,...args) { const rows=db.prepare(query).all(...args); return {toArray:()=>rows}; } });
  return {db,store};
}
const phone='+14165550123';
async function login(store, number=phone, now=Date.now()) { const c=await store.challenge(number,'ip-'+number,now); assert.ok(c.code); return store.verify(c.id,c.code,now); }
const event=(id='one',revision=1)=>({schemaVersion:1,id,groupId:'group-a',createdAt:1,updatedAt:revision,revision,title:'Friday',status:'planning',items:[],people:[]});
function backend(store) {
  return {challenge:store.challenge.bind(store),cancelChallenge:store.cancelChallenge.bind(store),verify:store.verify.bind(store),account:store.account.bind(store),logout:store.logout.bind(store),
    events:async s=>store.events(await store.account(s)),event:async(s,id)=>store.event(await store.account(s),id),workspace:async s=>store.workspace(await store.account(s)),saveWorkspace:async(s,data,revision)=>store.saveWorkspace(await store.account(s),data,revision)};
}
function request(path,method='GET',data,session='',origin='https://whim.test') {return new Request('https://whim.test'+path,{method,headers:{origin,'content-type':'application/json',cookie:'__Host-whim_session='+session},...(data!==undefined?{body:JSON.stringify(data)}:{})});}
test('codes are hashed, single-use, expiring; sessions are hashed and revocable',async()=>{
 const {db,store}=fixture(); const now=1000000; const c=await store.challenge(phone,'one',now);
 assert.equal(db.prepare('SELECT hash FROM challenges').get().hash,await hash(c.id+':'+c.code));
 const [a,b]=await Promise.all([store.verify(c.id,c.code,now),store.verify(c.id,c.code,now)]); assert.equal([a,b].filter(Boolean).length,1);
 const logged=a||b; assert.equal((await store.account(logged.session,now)).phone,phone);
 assert.notEqual(db.prepare('SELECT hash FROM sessions').get().hash,logged.session);
 assert.equal(await store.account(logged.session,now+SESSION_TTL),null);
 await store.logout(logged.session); assert.equal(await store.account(logged.session,now),null);
 const expired=await store.challenge(phone,'two',now); assert.equal(await store.verify(expired.id,expired.code,now+600000),null);
});
test('five wrong attempts invalidate a code and request limits apply to phone and IP',async()=>{
 const {store}=fixture(); const c=await store.challenge(phone,'ip',1);
 for(let i=0;i<5;i++)assert.equal(await store.verify(c.id,c.code==='000000'?'111111':'000000',2),null);
 assert.equal(await store.verify(c.id,c.code,3),null);
 await store.challenge(phone,'ip',4); await store.challenge(phone,'ip',5); assert.ok((await store.challenge(phone,'ip',6)).error);
 const second=fixture().store;
 for(let i=0;i<10;i++)assert.ok((await second.challenge('+141655510'+String(i).padStart(2,'0'),'same',1)).code);
 assert.ok((await second.challenge('+14165551999','same',2)).error);
 assert.ok((await store.challenge('not a phone','ip',1)).error);
});
test('events are restricted to verified group members; stale sync never replaces newer data',async()=>{
 const {store}=fixture(); const a=await login(store); const b=await login(store,'+14165550456');
 store.syncEvent({...event('one',2),title:'Updated'},[phone,'web:'+b.account.phone],2);
 store.syncEvent({...event('one',1),title:'Stale'},[phone],1);
 assert.equal(store.events(a.account)[0].title,'Updated'); assert.deepEqual(store.events(b.account),[]); assert.equal(store.event(b.account,'one'),null);
 store.syncEvent(event('two',3),[b.account.phone],3); assert.equal(store.events(b.account).length,2);
});
test('workspace persists per account and rejects stale saves',async()=>{
 const {store}=fixture(); const a=await login(store); const b=await login(store,'+14165550456');
 assert.deepEqual(store.workspace(a.account),{data:null,revision:0});
 assert.deepEqual(store.saveWorkspace(a.account,{widgets:['game']},0),{revision:1});
 assert.deepEqual(store.saveWorkspace(a.account,{widgets:[]},0),{conflict:true});
 assert.deepEqual(store.workspace(a.account).data,{widgets:['game']}); assert.equal(store.workspace(b.account).data,null);
});
test('roster replacement revokes access and delayed syncs cannot restore it',async()=>{
 const {store}=fixture(); const a=await login(store); const b=await login(store,'+14165550456');
 store.syncEvent(event(),[phone,b.account.phone],1);
 store.syncEvent({...event('one',2),title:'After removal'},[b.account.phone],2);
 assert.deepEqual(store.events(a.account),[]); assert.equal(store.event(a.account,'one'),null);
 assert.equal(store.event(b.account,'one').title,'After removal');
 // Both a delayed event and an equal-revision delivery with an old roster
 // must leave access revoked. A newer event with an older roster is unsafe too.
 for(const revision of [1,2,3]) store.syncEvent(event('one',revision),[phone],1);
 assert.deepEqual(store.events(a.account),[]);
 assert.equal(store.event(b.account,'one').title,'After removal');
 const db=backend(store),send=async()=>{};
 assert.equal((await websiteRequest(request('/api/events/one','GET',undefined,a.session),db,send)).status,404);
 store.syncEvent(event('one',2),[],3);
 assert.deepEqual(store.events(b.account),[]);
 store.syncEvent(event('one',3),[phone,b.account.phone],4);
 assert.equal(store.events(a.account).length,1);
});
test('HTTP sign-in sends a code privately, sets a secure HttpOnly cookie and logs out',async()=>{
 const {store}=fixture(); const db=backend(store); let delivered;
 const send=async(number,code)=>{delivered={number,code};};
 const response=await websiteRequest(request('/api/account/code','POST',{phone}),db,send);
 assert.equal(response.status,200); const c=await response.json(); assert.equal(c.code,undefined); assert.equal(delivered.number,phone);
 const logged=await websiteRequest(request('/api/account/verify','POST',{id:c.id,code:delivered.code}),db,send);
 assert.equal(logged.status,200); assert.match(logged.headers.get('set-cookie'),/HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/);
 const session=logged.headers.get('set-cookie').match(/=([^;]+)/)[1]; assert.ok((await logged.json()).account.id);
 assert.equal((await websiteRequest(request('/api/account/session','GET',undefined,session),db,send)).status,200);
 assert.equal((await websiteRequest(request('/api/account/logout','POST',undefined,session),db,send)).status,200);
 assert.equal((await websiteRequest(request('/api/events','GET',undefined,session),db,send)).status,401);
});
test('HTTP rejects cross-origin writes, oversized bodies and unauthorized event IDs',async()=>{
 const {store}=fixture();const db=backend(store); const send=async()=>{}; const a=await login(store); const b=await login(store,'+14165550456');store.syncEvent(event(),[phone],1);
 assert.equal((await websiteRequest(request('/api/account/code','POST',{phone},'','https://evil.test'),db,send)).status,403);
 assert.equal((await websiteRequest(request('/api/account/code','POST',{phone,extra:'x'.repeat(200001)}),db,send)).status,400);
 assert.equal((await websiteRequest(request('/api/events/one','GET',undefined,b.session),db,send)).status,404);
 const response=await websiteRequest(request('/api/events/one','GET',undefined,a.session),db,send);assert.equal(response.status,200); assert.equal((await response.json()).event.id,'one');
 const workspace={accountId:b.account.id,data:{account:{name:'',city:'',food:'',budget:''},friends:[],widgets:[],plans:[]},revision:0};
 assert.equal((await websiteRequest(request('/api/account/workspace','PUT',workspace,a.session),db,send)).status,409);
});
test('failed message delivery cancels the code and exposes no provider errors',async()=>{
 const {store,db}=fixture();const response=await websiteRequest(request('/api/account/code','POST',{phone}),backend(store),async()=>{throw new Error('provider secret');});
 assert.equal(response.status,503); assert.doesNotMatch(await response.text(),/provider secret/); assert.equal(db.prepare('SELECT count(*) n FROM challenges').get().n,0);
});
