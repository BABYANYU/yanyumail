// YanyuMail — Copyright 2026 烟雨. Original implementation.
const VERIFY=86400, ROUTE=2592000;
const locks=new Map();
async function serial(key,fn){const old=locks.get(key)||Promise.resolve();const next=old.catch(()=>{}).then(fn);locks.set(key,next);try{return await next;}finally{if(locks.get(key)===next)locks.delete(key);}}
async function tg(e,method,data){const r=await fetch(`https://api.telegram.org/bot${e.BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(18000)});const d=await r.json();if(!d.ok)throw new Error((d.description||'Telegram拒绝请求').slice(0,180));return d.result;}
async function say(e,id,text,extra={}){return tg(e,'sendMessage',{chat_id:id,text,...extra});}
async function get(e,k){return e.MAIL.get(k,'json');}
async function put(e,k,v,ttl){await e.MAIL.put(k,JSON.stringify(v),ttl?{expirationTtl:ttl}:undefined);}
async function rate(e,id,key,max,seconds){const k=`rate:${key}:${id}:${Math.floor(Date.now()/1000/seconds)}`;const n=(await get(e,k)||0)+1;await put(e,k,n,Math.max(60,seconds*2));return n<=max;}
async function challenge(e,id){
 if(!await rate(e,id,'challenge',3,300))return;
 const a=2+Math.floor(Math.random()*8),b=1+Math.floor(Math.random()*8),answer=a+b;
 const nonce=crypto.randomUUID().slice(0,12);const options=[answer,answer+1,answer-1].sort(()=>Math.random()-.5);
 await put(e,'quiz:'+id,{answer,nonce,tries:0},300);
 await say(e,id,`请完成验证后留言：${a}＋${b}＝？\n验证前的消息不会转交。`,{reply_markup:{inline_keyboard:[options.map(x=>({text:String(x),callback_data:`q:${nonce}:${x}`}))]}});
}
async function adminAct(e,act,id){
 if(act==='b'){await put(e,'ban:'+id,true);return `已拉黑 ${id}`;}
 if(act==='u'){const had=await get(e,'ban:'+id);if(!had)return `${id} 未处于拉黑状态`;await e.MAIL.delete('ban:'+id);return `已解封 ${id}`;}
 if(act==='t'){await put(e,'trust:'+id,true);return `已信任 ${id}，永久免验证`;}
 if(act==='x'){await e.MAIL.delete('trust:'+id);await e.MAIL.delete('verified:'+id);return `已取消信任 ${id}，下次需重新验证`;}
 if(act==='i'){return 'info';}
 return '未知操作';
}
async function callback(e,q){
 const from=String(q.from.id);
 if(from===String(e.ADMIN_ID)&&(q.data||'').startsWith('a:')){
  const p=(q.data||'').split(':'),act=p[1],id=p.slice(2).join(':');
  let text;
  if(act==='i'){
   const route=await get(e,`uid:${id}`);
   const banned=await get(e,'ban:'+id),trusted=await get(e,'trust:'+id),verified=await get(e,'verified:'+id);
   text='信息';
   await say(e,e.ADMIN_ID,`联系人：${route?.name||'未知'}\n用户名：${route?.username?'@'+route.username:'未设置'}\n用户ID：${id}\n状态：${banned?'已拉黑':trusted?'已信任':verified?'已验证（7天）':'未验证'}`);
  } else {
   text=await adminAct(e,act,id);
   if(text!=='info')await say(e,e.ADMIN_ID,text);
  }
  await tg(e,'answerCallbackQuery',{callback_query_id:q.id,text,show_alert:false});
  return;
 }
 const id=String(q.from.id);if(q.message?.chat.type!=='private'||String(q.message.chat.id)!==id)return;
 const quiz=await get(e,'quiz:'+id);const parts=(q.data||'').split(':');
 let text='验证已过期，请重新发送消息。';
 if(await get(e,'ban:'+id))text='当前无法使用。';
 else if(quiz&&parts[0]==='q'&&parts[1]===quiz.nonce){
  if(quiz.tries>=3)text='验证次数过多，请稍后重试。';
  else if(Number(parts[2])===quiz.answer){await put(e,'verified:'+id,true,VERIFY);await e.MAIL.delete('quiz:'+id);text='验证通过';await say(e,id,'验证通过，请简述来意。');}
  else{quiz.tries++;await put(e,'quiz:'+id,quiz,300);text=quiz.tries>=3?'验证次数过多，请稍后重试。':'答案不正确，请重试。';}
 }
 await tg(e,'answerCallbackQuery',{callback_query_id:q.id,text,show_alert:false});
}
async function owner(e,m){
 const text=(m.text||'').trim();let cmd=text.split(/\s/)[0].toLowerCase().split('@')[0];
 const alias={'/b':'/block','/ub':'/unblock','/t':'/trust','/ut':'/untrust','/i':'/info','/info':'/info'};
 cmd=alias[cmd]||cmd;
 if(cmd==='/start'||cmd==='/help'){await say(e,e.ADMIN_ID,'YanyuMail 管理帮助\n\n【身份卡按钮】首次联系会发一张身份卡，直接点：\n拉黑 / 解封 / 信任 / 信息\n\n【命令】引用联系人消息后发送：\n/block 或 /b 拉黑\n/unblock 或 /ub 解封\n/trust 或 /t 永久免验证\n/untrust 或 /ut 取消信任\n/info 或 /i 查看联系人\n\n【回复】引用消息后直接发文字或媒体即可\n未引用不会发送给任何人；路由保留 30 天；Bot 非端到端加密。');return;}
 if(!m.reply_to_message){await say(e,e.ADMIN_ID,'请引用对应联系人的消息后回复，避免误发。发送 /help 查看操作。');return;}
 const route=await get(e,`route:${m.reply_to_message.message_id}`);
 if(!route){await say(e,e.ADMIN_ID,'未找到对应联系人（路由可能已超过30天）。请引用近期收到的联系人消息。');return;}
 const id=route.id;
 if(cmd==='/block'){await put(e,'ban:'+id,true);await say(e,e.ADMIN_ID,`已拉黑 ${id}`);return;}
 if(cmd==='/unblock'){await e.MAIL.delete('ban:'+id);await say(e,e.ADMIN_ID,`已解封 ${id}`);return;}
 if(cmd==='/trust'){await put(e,'trust:'+id,true);await say(e,e.ADMIN_ID,`已永久信任 ${id}，仍受基本限频保护。`);return;}
 if(cmd==='/untrust'){await e.MAIL.delete('trust:'+id);await e.MAIL.delete('verified:'+id);await say(e,e.ADMIN_ID,`已取消信任及验证 ${id}`);return;}
 if(cmd==='/info'){await say(e,e.ADMIN_ID,`联系人：${route.name}\n用户名：${route.username?'@'+route.username:'未设置'}\n用户ID：${id}`);return;}
 if(await get(e,'ban:'+id)){await say(e,e.ADMIN_ID,'该联系人已拉黑，请先引用消息发送 /unblock。');return;}
 try{await tg(e,'copyMessage',{chat_id:id,from_chat_id:e.ADMIN_ID,message_id:m.message_id});}
 catch(err){await say(e,e.ADMIN_ID,`回复未送达（用户 ${id}）：${err.message}`);}
}
async function visitor(e,m){
 const id=String(m.from.id);if(await get(e,'ban:'+id))return;
 if((m.text||'').trim().toLowerCase()==='/id'){await say(e,id,`ID：${id}`);return;}
 if(!await rate(e,id,'inbound',20,60))return;
 const ok=await get(e,'trust:'+id)||await get(e,'verified:'+id);
 if(!ok){await challenge(e,id);return;}
 if((m.text||'').startsWith('/start')){await say(e,id,'验证有效，可直接发送消息。');return;}
 const name=[m.from.first_name,m.from.last_name].filter(Boolean).join(' ').replace(/[\r\n]/g,' ').slice(0,100);
 const route={id,name,username:m.from.username||''};
 try{
  if(!await get(e,'intro:'+id)){
   const card=await say(e,e.ADMIN_ID,`联系人：${name}\n用户名：${route.username?'@'+route.username:'未设置'}\n用户ID：${id}`,{reply_markup:{inline_keyboard:[[
    {text:'拉黑',callback_data:`a:b:${id}`},
    {text:'解封',callback_data:`a:u:${id}`},
    {text:'信任',callback_data:`a:t:${id}`},
    {text:'信息',callback_data:`a:i:${id}`}
   ]]}});
   await put(e,'uid:'+id,route,ROUTE);
   await put(e,`route:${card.message_id}`,route,ROUTE);await put(e,'intro:'+id,true,86400);
  }
  const sent=await tg(e,'copyMessage',{chat_id:e.ADMIN_ID,from_chat_id:id,message_id:m.message_id});
  await put(e,`route:${sent.message_id}`,route,ROUTE);
 }catch(err){
  if(!await get(e,'failnotice:'+id)){await put(e,'failnotice:'+id,true,3600);try{await say(e,id,'消息未能送达，请稍后重试。');}catch{}}
  try{await say(e,e.ADMIN_ID,`联系人 ${id} 消息转交失败：${err.message}`);}catch{}
 }
}
async function process(e,u){
 const m=u.message,q=u.callback_query;const uid=String(q?.from?.id||m?.from?.id||'');
 if(!uid)return;
 return serial(uid,async()=>{
  const key='update:'+u.update_id;if(await get(e,key))return;
  if(q)await callback(e,q);
  else if(m.chat?.type==='private'&&!m.from?.is_bot){if(uid===String(e.ADMIN_ID))await owner(e,m);else await visitor(e,m);}
  await put(e,key,true,86400);
 });
}
export default {async fetch(r,e){
 const p=new URL(r.url).pathname;
 if(p==='/health'&&r.method==='GET')return new Response('YanyuMail ok');
 if(p!=='/webhook'||r.method!=='POST')return new Response('Not found',{status:404});
 if(r.headers.get('X-Telegram-Bot-Api-Secret-Token')!==e.WEBHOOK_SECRET)return new Response('Forbidden',{status:403});
 if(Number(r.headers.get('Content-Length'))>1048576)return new Response('Too large',{status:413});
 try{const raw=await r.text();if(raw.length>1048576)return new Response('Too large',{status:413});await process(e,JSON.parse(raw));return new Response('ok');}
 catch(err){ console.error('handler error',String(err&&err.message||err)); }
 return new Response('ok');
}};
