import worker from '../src/worker.mjs';
import assert from 'node:assert/strict';
const store=new Map(),calls=[];let seq=10000,failCopy=false;
const env={BOT_TOKEN:'test',ADMIN_ID:'1',WEBHOOK_SECRET:'s',MAIL:{get:async k=>store.has(k)?JSON.parse(store.get(k)):null,put:async(k,v)=>store.set(k,v),delete:async k=>store.delete(k)}};
globalThis.fetch=async(url,opts)=>{const method=url.split('/').at(-1),data=JSON.parse(opts.body);calls.push({method,...data});return Response.json(failCopy&&method==='copyMessage'?{ok:false,description:'test failure'}:{ok:true,result:{message_id:++seq}});};
async function post(payload){return worker.fetch(new Request('https://test/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'s'},body:JSON.stringify({update_id:++seq,...payload})}),env);}
async function msg(id,text,reply){await post({message:{message_id:++seq,chat:{id,type:'private'},from:{id,first_name:'T'},text,...(reply?{reply_to_message:{message_id:reply}}:{})}});}
function reset(){store.clear();calls.length=0;failCopy=false;}
reset();store.set('route:42',JSON.stringify({id:'2',name:'T'}));await msg('1','/i',42);assert(!calls.some(c=>c.method==='copyMessage'));assert(calls.some(c=>c.text?.includes('用户ID：2')));
reset();await msg('1','/id');assert(calls.some(c=>c.text==='ID：1'));
reset();for(let i=0;i<25;i++)await msg('2','/id');assert.equal(calls.filter(c=>c.method==='sendMessage').length,20);
reset();store.set('verified:2','true');await msg('2','/START payload');assert(!calls.some(c=>c.method==='copyMessage'));assert(calls.some(c=>c.text?.includes('验证有效')));
reset();await post({callback_query:{id:'c',from:{id:'1'},message:{chat:{id:'-100',type:'supergroup'}},data:'a:b:2'}});assert(!store.has('ban:2'));
reset();await post({callback_query:{id:'c',from:{id:'1'},message:{chat:{id:'1',type:'private'}},data:'a:b:garbage'}});assert(!store.has('ban:garbage'));
reset();store.set('verified:2','true');store.set('intro:2','true');failCopy=true;await msg('2','one');await msg('2','two');assert.equal(calls.filter(c=>c.method==='sendMessage'&&c.chat_id==='1').length,1);assert.equal(calls.filter(c=>c.method==='sendMessage'&&c.chat_id==='2').length,1);
console.log('PASS: /i不误发、管理员/id、访客/id限频、START参数解析、按钮来源校验、畸形参数拒绝、双方失败提示节流');
