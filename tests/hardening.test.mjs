import worker from '../src/worker.mjs';
const data=new Map(),calls=[];
const mkEnv=(admin='1')=>({ADMIN_ID:admin,BOT_TOKEN:'t',WEBHOOK_SECRET:'s',MAIL:{get:async k=>data.has(k)?JSON.parse(data.get(k)):null,put:async(k,v)=>{data.set(k,v);},delete:async k=>{data.delete(k);}}});
let e=mkEnv(),failSend=false,mid=100;
globalThis.fetch=async(url,opt)=>{const m=url.split('/').pop(),d=JSON.parse(opt.body);calls.push({m,...d});if(failSend&&m==='sendMessage')throw new Error('send failed');return Response.json({ok:true,result:m==='answerCallbackQuery'?true:{message_id:++mid}});};
const post=(u,env=e,ctx)=>worker.fetch(new Request('https://t/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'s'},body:JSON.stringify(u)}),env,ctx);
const ok=(v,msg)=>{if(!v)throw Error(msg)};
let uid=1;const msg=(id,text)=>({update_id:uid++,message:{message_id:uid,chat:{id,type:'private'},from:{id,first_name:'T'},text}});

// 1. waitUntil：立即返回，工作在后台完成
let pending=[];
const ctx={waitUntil:p=>pending.push(p)};
const r=await post(msg('2','hi'),e,ctx);
ok(r.status===200,'ack 200');
ok(calls.length===0,'未阻塞返回');
await Promise.all(pending);
ok(calls.some(c=>c.m==='sendMessage'&&c.chat_id==='2'),'waitUntil 后台执行');

// 2. 并发重复投递同一 update 只处理一次
data.clear();calls.length=0;
const dup={update_id:999,message:{message_id:500,chat:{id:'2',type:'private'},from:{id:'2',first_name:'T'},text:'hello'}};
await Promise.all([post(dup),post(dup)]);
const quizSends=calls.filter(c=>c.m==='sendMessage'&&c.chat_id==='2').length;
ok(quizSends===1,'重复投递只发一次验证题');

// 3. 验证限频后有回执，不再静默
data.clear();calls.length=0;
for(let i=0;i<5;i++)await post(msg('2','spam'));
const notices=calls.filter(c=>c.m==='sendMessage'&&c.chat_id==='2');
ok(notices.some(c=>/请稍后重试/.test(c.text)),'限频回执');

// 4. sendMessage 失败时仍应答按钮，不卡转圈
data.clear();calls.length=0;failSend=true;
const q={update_id:uid++,callback_query:{id:'cb',from:{id:'2'},message:{chat:{id:'2',type:'private'}},data:'q:x:1'}};
await post(q);
failSend=false;
ok(calls.some(c=>c.m==='answerCallbackQuery'),'异常时仍应答回调');

// 5. 配置缺失时 /health 报错
const bad=mkEnv('');delete bad.BOT_TOKEN;
const h=await worker.fetch(new Request('https://t/health'),bad);
ok(h.status===500&&/BOT_TOKEN/.test(await h.text()),'配置缺失可诊断');

// 6. 取消信任按钮
data.clear();calls.length=0;
data.set('trust:2',JSON.stringify(true));data.set('verified:2',JSON.stringify(true));
await post({update_id:uid++,callback_query:{id:'cb2',from:{id:'1'},message:{chat:{id:'1',type:'private'}},data:'a:x:2'}});
ok(!data.has('trust:2')&&!data.has('verified:2'),'取消信任按钮生效');

// 7. 处理异常不外抛
data.clear();
const envErr=mkEnv();const origGet=envErr.MAIL.get;
envErr.MAIL.get=async k=>{if(k.startsWith('ban:'))throw new Error('kv boom');return origGet(k);};
const resErr=await post({update_id:uid++,message:{message_id:1,chat:{id:'2',type:'private'},from:{id:'2'},text:'x'}},envErr);
ok(resErr.status===200,'异常仍返回200');

console.log('PASS: 立即应答、并发去重、限频回执、回调必答、配置自检、取消信任、异常不外抛');
