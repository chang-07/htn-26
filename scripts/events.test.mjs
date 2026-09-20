import test from 'node:test';
import assert from 'node:assert/strict';
import { eventInputSchema, eventFromPlan } from '../src/shared/events.ts';
import { eventView } from '../src/client/event-view.ts';
import { EMPTY_PLAN } from '../src/types.ts';
const document = (input) => ({...eventInputSchema.parse(input),schemaVersion:1,id:'event',groupId:'group',createdAt:1,updatedAt:1,revision:1,people:['Alex','Sam']});
test('one event preserves unrelated item kinds and nested provider-specific details',()=>{
 const e=document({title:'Birthday weekend',timeZone:'America/Toronto',items:[
  {id:'flight',kind:'flight',title:'Fly to Toronto',startsAt:'2026-10-01T13:00:00-04:00',details:{airline:'Air Canada',flightNumber:'AC123',baggage:{checked:1,carryOn:1}},links:[{label:'Manage flight',url:'https://aircanada.com/booking?ref=abc',kind:'booking'}]},
  {id:'food',kind:'food',title:'Pizza for everyone',details:{dietary:['vegetarian','no nuts'],items:[{name:'Margherita',quantity:3}]}},
  {id:'driver',kind:'ride',title:'Ride to the venue',timeLabel:'After dinner',details:{pickup:'Union Station',vehicle:'Van',seats:6}},
  {id:'game',kind:'custom_game',title:'Birthday trivia',details:{rounds:5,teamNames:['Blue','Pink']}},
 ]});
 const roundtrip=JSON.parse(JSON.stringify(e));assert.equal(roundtrip.items[0].details.baggage.checked,1);assert.equal(roundtrip.items[1].details.items[0].quantity,3);assert.equal(roundtrip.items[3].kind,'custom_game');
 const view=eventView(roundtrip);assert.equal(view.items[0].url,'https://aircanada.com/booking?ref=abc');assert.ok(view.items[0].notes.some(n=>n.includes('carryOn: 1')));assert.equal(view.schedule[1].events[1].time,'After dinner');assert.ok(view.schedule[1].events[2].details.some(d=>d==='rounds: 5'));assert.equal(view.items.length,1);
});
test('invalid links, inverted times, duplicate IDs, invalid zones and oversized payloads fail validation',()=>{
 for(const input of [
 {title:'x',items:[{id:'x',kind:'ride',title:'x',links:[{label:'x',url:'javascript:alert(1)'}]}]},
 {title:'x',startsAt:'2026-10-02T12:00:00Z',endsAt:'2026-10-01T12:00:00Z'},
 {title:'x',items:[{id:'same',kind:'x',title:'a'},{id:'same',kind:'x',title:'b'}]},
 {title:'x',timeZone:'Not/a-zone'},
 {title:'x',items:[{id:'x',kind:'x',title:'x',details:{huge:'x'.repeat(100001)}}]},
 ]) assert.equal(eventInputSchema.safeParse(input).success,false);
});
test('legacy conversion keeps real links, avoids duplicate chosen options and does not label tracking or payment as confirmed booking',()=>{
 const state={...EMPTY_PLAN,title:'Friday',version:5,status:'booked',chosenOptionId:'option',options:[{id:'option',title:'Show',bookingUrl:'https://tickets.test/order'}],itinerary:[{id:'show',title:'Show',kind:'event',status:'confirmed',url:'https://tickets.test/order'},{id:'flight',title:'Flight status',kind:'flight',status:'watching'}],carts:[{shop:'pizza.test',total:'$40',checkoutUrl:'https://pizza.test/checkout?token=abc',paidBy:'Alex',lines:[{title:'Pizza',quantity:2,price:'$20'}]}]};
 const e=eventFromPlan(state,'group','event',100);
 assert.equal(e.items.length,3);assert.equal(e.items[0].status,'booked');assert.equal(e.items[1].status,'in_progress');assert.equal(e.items[2].status,'needs_confirmation');assert.equal(e.items[2].links[0].url,'https://pizza.test/checkout?token=abc');assert.match(e.items[2].details.Payment,/fulfillment not confirmed/);
 const next=eventFromPlan({...state,event:{...e,items:[...e.items,{id:'custom',kind:'game',title:'Trivia',status:'saved',source:'agent',links:[],details:{rounds:4}}]},version:6},'group','event',200);
 assert.equal(next.id,e.id);assert.equal(next.createdAt,100);assert.equal(next.revision,6);assert.equal(next.items.filter(i=>i.id==='custom').length,1);assert.equal(next.items.length,4);
});
test('timeline uses event timezone, sorts times, keeps untimed activities and exposes all booking links',()=>{
 const e=document({title:'Night out',timeZone:'America/Toronto',items:[{id:'late',kind:'ride',title:'Home',startsAt:'2026-10-02T01:00:00Z',endsAt:'2026-10-02T02:00:00Z',links:[{label:'Track',url:'https://ride.test/track',kind:'tracking'},{label:'Manage',url:'https://ride.test/booking',kind:'booking'}]}, {id:'early',kind:'food',title:'Dinner',startsAt:'2026-10-01T22:00:00Z'}, {id:'unscheduled',kind:'game',title:'Board games'}, {id:'idea',kind:'food',title:'Alternative',status:'idea'}]});
 const view=eventView(e);assert.equal(view.schedule.length,2);assert.equal(view.schedule[0].date,'Oct 1');assert.equal(view.schedule[0].events[0].title,'Dinner');assert.equal(view.schedule[1].events[0].time,'Time TBD');assert.equal(view.items[0].url,'https://ride.test/booking');assert.equal(view.items[0].links[0].url,'https://ride.test/track');
});

test('model tool schemas serialize and validate custom event details',async()=>{
 const {build}=await import('esbuild');
 const bundle=await build({entryPoints:['src/server/tools/index.ts'],bundle:true,write:false,format:'esm',platform:'node'});
 const tools=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
 const schema=tools.openAiTools().find(tool=>tool.function.name==='save_event');assert.ok(schema);assert.doesNotThrow(()=>JSON.stringify(schema));
 const args=tools.parseToolArgs('save_event',JSON.stringify({event:{title:'Picnic',items:[{id:'supplies',kind:'supplies',title:'Blankets',details:{quantity:4}}]}}));
 assert.equal(args.event.items[0].details.quantity,4);
});
