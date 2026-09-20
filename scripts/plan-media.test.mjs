import test from 'node:test';
import assert from 'node:assert/strict';
import {companyDomain, mediaKey, downloadMedia, generateCover, collectPlanMedia, mediaCompanies} from '../src/server/plan-media.ts';
const plan = {title:'Friday game night',status:'voting',options:[{id:'1',title:'Venue',bookingUrl:'https://www.venue.com/book?token=secret'}],counts:{},awaiting:[],version:1};
const png = () => new Response(new Uint8Array([137,80,78,71]), {headers:{'content-type':'image/png'}});
const jpeg = {type:'image/jpeg',data:Buffer.from([255,216,255,224,0,16,255,217]).toString('base64')};

test('media fingerprints ignore voting changes and checkout secrets but track companies', () => {
  assert.equal(companyDomain('http://localhost:8080'),undefined);
  assert.equal(companyDomain('http://127.0.0.1'),undefined);
  assert.equal(companyDomain('https://user:pass@example.com'),undefined);
  assert.equal(companyDomain('https://venue.internal'),undefined);
  assert.equal(mediaKey(plan),mediaKey({...plan,version:9,counts:{1:3},options:[{...plan.options[0],bookingUrl:'https://venue.com/book?token=changed'}]}));
  assert.notEqual(mediaKey(plan),mediaKey({...plan,title:'Ibiza'}));
  assert.notEqual(mediaKey(plan),mediaKey({...plan,carts:[{shop:'Uber',checkoutUrl:'https://uber.com/ride',lines:[],total:'$10'}]}));
});
test('logo downloader rejects off-CDN redirects, HTML, and oversized streamed responses', async () => {
  let calls=0;
  await assert.rejects(downloadMedia('https://www.google.com/s2/favicons',100,async()=>{calls++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}})}),/Unsupported/);
  assert.equal(calls,1);
  await assert.rejects(downloadMedia('https://www.google.com/s2/favicons',100,async()=>new Response('<html>',{headers:{'content-type':'text/html'}})),/Invalid/);
  await assert.rejects(downloadMedia('https://www.google.com/s2/favicons',2,async()=>png()),/too large/);
});
test('image generation requests one JPEG cover and validates the returned image', async () => {
  const file=await generateCover(plan.title,{OPENAI_API_KEY:'test'},async(url,init)=>{
    assert.equal(url,'https://api.openai.com/v1/images/generations');
    assert.equal(init.method,'POST');
    assert.ok(init.signal instanceof AbortSignal);
    const body=JSON.parse(init.body);
    assert.equal(body.model,'gpt-image-2'); assert.equal(body.n,1);
    assert.equal(body.quality,'low'); assert.equal(body.output_format,'jpeg');
    assert.ok(body.prompt.includes(plan.title));
    assert.ok(!body.prompt.includes('secret'));
    return Response.json({data:[{b64_json:jpeg.data}]});
  });
  assert.deepEqual(file,jpeg);
  await assert.rejects(generateCover('Test',{OPENAI_API_KEY:'test'},async()=>Response.json({data:[{b64_json:btoa('not a jpeg')}]})),/Expected a JPEG/);
  await assert.rejects(generateCover('Test',{OPENAI_API_KEY:''},async()=>assert.fail('should not fetch')),/OPENAI_API_KEY/);
  await assert.rejects(generateCover('Test',{OPENAI_API_KEY:'test'},async()=>new Response(null,{status:429})),/429/);
});
test('generated cover and company icons are stored; repeat visits do no extra work', async () => {
  const urls=[];const stored=[];
  const media=await collectPlanMedia(plan,async()=>jpeg,async file=>{stored.push(file);return '/saved/'+stored.length},async url=>{urls.push(url);return png();});
  assert.equal(stored.length,2);
  assert.equal(media.cover.generated,true);
  assert.ok(media.logos['venue.com']);
  assert.ok(urls.every(url=>url.startsWith('https://www.google.com/s2/favicons')));
  assert.ok(!urls.some(url=>url.includes('secret')));
  const reused=await collectPlanMedia({...plan,media},async()=>assert.fail('should not regenerate'),async()=>assert.fail('should reuse files'),async()=>assert.fail('should not fetch again'));
  assert.deepEqual(reused,media);
});
test('generation failures preserve independently fetched logos with no stock-photo fallback', async () => {
  const media=await collectPlanMedia(plan,async()=>{throw new Error('generation unavailable')},async()=>'/logo',async()=>png());
  assert.equal(media.cover,undefined);
  assert.equal(media.logos['venue.com'],'/logo');
});
test('legacy web covers are replaced; booking changes reuse generated covers', async () => {
  let generations=0;
  const state={...plan,media:{title:plan.title,cover:{url:'/web-photo',attributionFree:true},logos:{'venue.com':'/logo'}}};
  const media=await collectPlanMedia(state,async()=>{generations++;return jpeg},async()=>'/ai-cover',async()=>assert.fail('reuse logo'));
  assert.equal(generations,1); assert.equal(media.cover.url,'/ai-cover');
  const updated=await collectPlanMedia({...plan,media,carts:[{shop:'Uber',checkoutUrl:'https://uber.com/ride',lines:[],total:'$10'}]},async()=>assert.fail('do not regenerate on booking changes'),async()=>'/uber',async()=>png());
  assert.deepEqual(updated.cover,media.cover);
  assert.equal(updated.logos['uber.com'],'/uber');
  const newEvent=await collectPlanMedia({...plan,title:'Picnic',media},async()=>{generations++;return jpeg},async()=>'/picnic',async()=>assert.fail('reuse logo'));
  assert.equal(generations,2); assert.equal(newEvent.cover.url,'/picnic');
});

test('generic event providers and legacy itinerary links receive company logos without leaking full URLs', () => {
 const state={...plan,options:[],itinerary:[{url:'https://www.aircanada.com/booking?secret=abc'}],event:{items:[{provider:{name:'Uber',url:'https://uber.com'},links:[{url:'https://m.uber.com/ride?token=private'}]}]}};
 assert.deepEqual(mediaCompanies(state),['aircanada.com','m.uber.com','uber.com']);
 assert.doesNotMatch(mediaKey(state),/private|secret|abc/);
});
