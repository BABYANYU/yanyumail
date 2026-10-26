import worker from '../src/worker.mjs';
const data=new Map(),calls=[];
const e={ADMIN_ID:'1',BOT_TOKEN:'t',WEBHOOK_SECRET:'s',MAIL:{get:async k=>data.has(k)?JSON.parse(data.get(k)):null,put:async(k,v)=>data.set(k,v),delete:async k=>data.delete(k)}};
let mid=100;
globalThis.fetch=async(url,opt)=>{const m=url.split('/').pop(),d=JSON.parse(opt.body);calls.push({m,...d});return Response.json({ok:true,result:m==='answerCallbackQuery'?true:{message_id:++mid}});};
async function send(u){return worker.fetch(new Request('https://t/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'s'},body:JSON.stringify(u)}),e);}
const ok=(v,msg)=>{if(!v)throw Error(msg)};

// 访客通过验证并发消息，触发身份卡
let u=1;
await send({update_id:u++,message:{message_id:1,chat:{id:'2',type:'private'},from:{id:'2',first_name:'Chen',username:'chen_dev'},text:'hi'}});
const quiz=JSON.parse(data.get('quiz:2'));
await send({update_id:u++,callback_query:{id:'q',from:{id:'2'},message:{chat:{id:'2',type:'private'}},data:`q:${quiz.nonce}:${quiz.answer}`}});
await send({update_id:u++,message:{message_id:2,chat:{id:'2',type:'private'},from:{id:'2',first_name:'Chen',username:'chen_dev'},text:'hello'}});

const card=calls.filter(x=>x.m==='sendMessage'&&x.chat_id==='1').at(-1);
const btns=card.reply_markup.inline_keyboard[0];
ok(btns.map(b=>b.text).join(',')==='拉黑,解封,信任,信息','card buttons');
ok(btns.every(b=>b.callback_data.endsWith(':2')),'callback carries uid');
ok(data.has('uid:2'),'uid index saved');

// 按钮：信息
await send({update_id:u++,callback_query:{id:'c1',from:{id:'1'},message:{chat:{id:'1',type:'private'}},data:'a:i:2'}});
ok(calls.some(x=>x.m==='sendMessage'&&/用户ID：2/.test(x.text||'')),'info button');

// 按钮：拉黑 → 访客被拦
await send({update_id:u++,callback_query:{id:'c2',from:{id:'1'},message:{chat:{id:'1',type:'private'}},data:'a:b:2'}});
ok(data.has('ban:2'),'block button');
const n=calls.length;
await send({update_id:u++,message:{message_id:3,chat:{id:'2',type:'private'},from:{id:'2',first_name:'Chen'},text:'spam'}});
ok(calls.length===n,'blocked user silent');

// 按钮：解封
await send({update_id:u++,callback_query:{id:'c3',from:{id:'1'},message:{chat:{id:'1',type:'private'}},data:'a:u:2'}});
ok(!data.has('ban:2'),'unblock button');

// 按钮：信任
await send({update_id:u++,callback_query:{id:'c4',from:{id:'1'},message:{chat:{id:'1',type:'private'}},data:'a:t:2'}});
ok(data.has('trust:2'),'trust button');

// 短别名：/ut 与 /i 需引用消息
await send({update_id:u++,message:{message_id:4,chat:{id:'1',type:'private'},from:{id:'1'},text:'/ut',reply_to_message:{message_id:[...data.keys()].filter(k=>k.startsWith('route:')).map(k=>+k.split(':')[1]).at(-1)}}});
ok(!data.has('trust:2'),'alias /ut');

// 非管理员点击按钮无效
await send({update_id:u++,callback_query:{id:'c5',from:{id:'3'},message:{chat:{id:'3',type:'private'}},data:'a:b:2'}});
ok(!data.has('ban:2'),'non-admin cannot act');

// 未引用直接发命令
const before=calls.length;
await send({update_id:u++,message:{message_id:5,chat:{id:'1',type:'private'},from:{id:'1'},text:'/b'}});
ok(/请引用/.test(calls.filter(x=>x.m==='sendMessage').at(-1).text),'requires quote');

console.log('PASS: 身份卡按钮、信息查询、拉黑解封、信任、短别名、非管理员拒绝、未引用拦截');
