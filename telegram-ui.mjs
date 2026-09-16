// Telegram callback data contains only a short opaque reference, never product text.
const PAGE_SIZE=8;
export function inlineMarkup(ledger, row, payload) {
  const rows=payload.keyboard || [];
  const pages=Math.max(1,Math.ceil(rows.length/PAGE_SIZE));
  const page=Math.max(0,Math.min(payload.page || 0,pages-1));
  const actions=[];
  const button=(text,action)=>{
    const index=actions.push(action)-1;
    return {text,callback_data:`ui:${row.id}:${index}`};
  };
  const labels={'📥 Купить':'📥 Купить','💰 Продать':'💰 Продать','💀 ПОТРАЧЕНО':'💀 ПОТРАЧЕНО','🔄 Avito':'🔄 Avito','📦 Склад':'📦 Склад','🧹 Очистить':'🧹 Очистить склад','📈 Статистика':'📈 Статистика','⚠️ Залежались':'⚠️ Залежались','📊 Отчёт':'📊 Отчёт','🗓 За месяц':'🗓 За месяц','ℹ️ Помощь':'ℹ️ Помощь'};
  const keyboard=rows.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE).map(r=>r.map(command=>{
    let label=labels[command] || command;
    if(/^В доставке #\d+$/.test(command)) label='🚚 Едет к покупателю';
    if(/^Покупатель забрал #\d+$/.test(command)) label='✅ Покупатель забрал';
    if(/^Возврат #\d+$/.test(command)) label='↩️ Возврат на склад';
    if(/^Добавить Avito #/.test(command)) label='Добавить в учёт';
    if(/^Пропустить Avito #/.test(command)) label='Пропустить';
    const product=command.match(/^(Продать|Расход) #\d+ · (.+)$/);
    if(product) label=product[2];
    return button(label,{command});
  }));
  if(pages>1) {
    const nav=[];
    if(page>0) nav.push(button('← Предыдущие',{page:page-1}));
    if(page<pages-1) nav.push(button('Следующие →',{page:page+1}));
    keyboard.push(nav);
  }
  if(payload.url && /^https:\/\/(www\.)?avito\.ru\//.test(payload.url)) keyboard.push([{text:'Открыть объявление ↗',url:payload.url}]);
  ledger.set(`ui:${row.id}`,{chat:row.chat,actions,payload,session:JSON.stringify(ledger.get('session')),used:false});
  return {inline_keyboard:keyboard};
}
export function bindMessage(ledger, screenId, messageId) {
  const screen=ledger.get(`ui:${screenId}`); if(!screen) return;
  screen.messageId=messageId; ledger.set(`ui:${screenId}`,screen);
}
export function resolveCallback(ledger, query) {
  const owner=ledger.get('owner');
  if(!owner || query.from?.id!==owner || query.message?.chat?.id!==owner || query.message?.chat?.type!=='private') return {error:'Нет доступа.'};
  const match=query.data?.match(/^ui:(\d+):(\d+)$/);
  if(!match) return {error:'Кнопка устарела. Отправь /menu.'};
  const key=`ui:${match[1]}`, screen=ledger.get(key);
  const avitoAction=screen?.actions?.[Number(match[2])]?.command?.startsWith('Добавить Avito #') || screen?.actions?.[Number(match[2])]?.command?.startsWith('Пропустить Avito #');
  if(!screen || screen.used || screen.chat!==owner || screen.messageId!==query.message.message_id || (!avitoAction && screen.session!==JSON.stringify(ledger.get('session'))))
    return {error:'Этот шаг уже завершён. Используй последнее сообщение или /menu.'};
  const action=screen.actions[Number(match[2])];
  if(!action) return {error:'Кнопка недоступна.'};
  screen.used=true; ledger.set(key,screen);
  return action.page!==undefined ? {payload:{...screen.payload,page:action.page}} : {command:action.command};
}

export async function deliver(ledger,row,api) {
  const p=JSON.parse(row.payload);
  // Every inline screen has an always-available way back to the main menu.
  // Keep it on the first page even when a screen has many product buttons.
  const withoutMenu=(p.keyboard||[]).filter(r=>!r.includes('МЕНЮ') && !r.includes('/menu'));
  p.keyboard=[['МЕНЮ'],...withoutMenu];
  // ReplyKeyboardRemove and inline markup cannot coexist in the same message.
  if(!ledger.get(`inline_migrated:${row.chat}`)) {
    await api('sendMessage',{chat_id:row.chat,text:'Кнопки теперь под сообщениями.',reply_markup:{remove_keyboard:true}});
    ledger.set(`inline_migrated:${row.chat}`,true);
  }
  const keepSeparate=/(?:Новое объявление|Объявление ещё не добавлено|Следующее объявление Avito)/i.test(p.text||'') || p.document;
  const parts=[]; let remaining=p.text;
  while(remaining.length>3500) {
    let n=remaining.lastIndexOf('\n',3500); if(n<=0) n=3500;
    parts.push(remaining.slice(0,n)); remaining=remaining.slice(n).trimStart();
  }
  parts.push(remaining);
  for(let i=0;i<parts.length;i++) {
    const last=i===parts.length-1;
    const markup=last?inlineMarkup(ledger,row,p):undefined;
    const previous=last && !keepSeparate ? ledger.get(`last_message:${row.chat}`) : null;
    let result;
    if(previous) {
      try { result=await api('editMessageText',{chat_id:row.chat,message_id:previous,text:parts[i],reply_markup:markup}); }
      catch { result=await api('sendMessage',{chat_id:row.chat,text:parts[i],...(markup?{reply_markup:markup}:{})}); }
    } else result=await api('sendMessage',{chat_id:row.chat,text:parts[i],...(markup?{reply_markup:markup}:{})});
    if(last) { const messageId=result.message_id || previous; bindMessage(ledger,row.id,messageId); if(!keepSeparate) ledger.set(`last_message:${row.chat}`,messageId); }
  }
  if(p.document) {
    const data=new FormData(); data.set('chat_id',String(row.chat));
    data.set('document',new Blob([JSON.stringify(p.document,null,2)],{type:'application/json'}),'perekup-export.json');
    await api('sendDocument',data,true);
  }
  ledger.db.prepare('DELETE FROM outbox WHERE id=?').run(row.id);
}
