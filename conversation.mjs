import { InputError, assert, money, date, id, today, rub } from './ledger.mjs';
import { resolveCallback } from './telegram-ui.mjs';

export const menu = [['💀 ПОТРАЧЕНО','🔄 Avito'], ['📦 Склад','🧹 Очистить'], ['📈 Статистика','⚠️ Залежались'], ['📊 Отчёт','🗓 За месяц'], ['ℹ️ Помощь']];
export const moreMenu = menu;
const help = `Учёт компьютеров и комплектующих.\n\n🔄 Avito — синхронизация объявлений и цен.\n📦 Склад — карточки товаров, доставка, переименование и удаление.\n⚠️ Залежались — объявления, которые висят больше 7 дней.\n💀 ПОТРАЧЕНО — быстрый расход с датой сегодняшнего дня.\n📊 Отчёт — прибыль, расходы и категории.\n\n/stock — склад, /report — отчёт, /cancel — отмена текущего ввода.\nСуммы вводятся в рублях, даты — ГГГГ-ММ-ДД.`;

const flows = {
  'Купил': {op:'buy', kind:'purchase', fields:[['name','Что купил? Например: RTX 3060 12GB, MSI, серийник …'],['cost','Сколько заплатил за эту штуку? В рублях, например 15000.'],['acquired','Дата покупки? Напиши «Сегодня» или ГГГГ-ММ-ДД.']]},
  'Было в наличии': {op:'buy', kind:'opening', fields:[['name','Какой товар уже лежит у тебя? Одна запись — одна штука.'],['cost','За сколько покупал эту штуку?'],['acquired','Когда покупал? «Сегодня» или ГГГГ-ММ-ДД.']]},
  'Продал': {op:'sell', fields:[['item','Номер проданного товара из «Склада»? Например 3.'],['amount','За сколько продал? Сумма, которую покупатель заплатил, до расходов. Комиссию/доставку занеси отдельным расходом.'],['day','Дата продажи? «Сегодня» или ГГГГ-ММ-ДД.']]},
  'Расход': {op:'expense', fields:[['item','На какой товар расход? Его номер, либо 0 для общих расходов.'],['amount','Сколько потратил? Сумма в рублях.'],['note','На что потратил? Например: ремонт, доставка, продвижение.'],['day','Дата оплаты расхода? «Сегодня» или ГГГГ-ММ-ДД.']]},
  '💀 ПОТРАЧЕНО': {op:'quick_expense', fields:[['amount','Сколько потратил? Введи сумму в рублях. Дата будет поставлена автоматически сегодня.']]},
  'Потрачено': {op:'quick_expense', fields:[['amount','Сколько потратил? Введи сумму в рублях. Дата будет поставлена автоматически сегодня.']]},
  'Собрать ПК': {op:'build', fields:[]},
  'Разобрать ПК': {op:'dismantle', fields:[]}
};
function question(session) {
  const [field,text] = session.fields[session.step];
  return {text, keyboard:['acquired','day'].includes(field) ? [['Сегодня'],['Назад','Отмена']] : [['Назад','Отмена']]};
}
function stockButtons(ledger, action) {
  const rows=ledger.all().filter(r=>!r.parent&&!r.sold_on&&!r.dismantled).map(r=>[`${action} #${r.id} · ${r.name}`]);
  return rows.length ? [...rows,['Отмена']] : [['Отмена']];
}
function stockMenu(ledger) { return [['Очистить склад'], ...ledger.stockItems().map(r=>[`Товар #${r.id} · ${r.name}`]), ['Назад']]; }
function nextAvito(ledger) {
  const owner=ledger.get('owner');
  const row=ledger.db.prepare(`SELECT a.* FROM avito_items a
    WHERE a.status='active' AND NOT EXISTS (SELECT 1 FROM items i WHERE i.avito_id=a.id)
    ORDER BY a.seen_at ASC LIMIT 1`).get();
  if(!owner || !row) return false;
  ledger.db.prepare('INSERT INTO outbox(chat,payload) VALUES(?,?)').run(owner,JSON.stringify({
    text:`Следующее объявление Avito:\n${row.title}\nЦена на Avito: ${rub(row.price*100)} ₽\n${row.url}\n\nДобавить в склад?`,
    url:row.url,keyboard:[[`Добавить Avito #${row.id}`,`Пропустить Avito #${row.id}`]]
  }));
  return true;
}
function queueAvito(ledger,id) {
  const q=ledger.get('avito_queue',[]);
  if(!q.includes(id) && !ledger.hasAvitoItem(id)) { q.push(id); ledger.set('avito_queue',q); }
}
function summary(ledger, s) {
  const d=s.data;
  const names = d.item ? `#${d.item} ${ledger.item(d.item).name}` : 'общие расходы';
  if(s.op==='dispatch') return `🚚 Едет к покупателю\n${names}\nК получению: ${rub(d.amount)}\nДо получения покупателем эта сумма не входит в доход.`;
  if(s.op==='receive') return `✅ Покупатель забрал\n${names}\nДоход: ${rub(ledger.item(d.item).expected_payout)}\nДата: ${d.day}`;
  if(s.op==='returnDelivery') return `Вернуть ${names} на склад без начисления дохода?`;
  if(s.op==='buy') return `${d.kind==='opening'?'Начальные запасы':'Покупка'}: ${d.name}\nСтоимость: ${rub(d.cost)}\nДата: ${d.acquired}`;
  if(s.op==='sell') return `Продажа: ${names}\nЦена: ${rub(d.amount)}\nСебестоимость: ${rub(ledger.cost(d.item))}\nРезультат сделки: ${rub(d.amount-ledger.cost(d.item))}\nДата: ${d.day}`;
  if(s.op==='expense') return `Расход: ${names}\n${d.note} · ${rub(d.amount)}\nДата: ${d.day}`;
  if(s.op==='quick_expense') return `Быстрый расход\nСумма: ${rub(d.amount)}\nДата записи: ${d.day}\n\nОн попадёт в общие расходы этого месяца.`;
  if(s.op==='build') return `Сборка: ${d.name}\n${d.ids.map(n=>`#${n} ${ledger.item(n).name}`).join('\n')}\nСебестоимость: ${rub(d.ids.reduce((a,n)=>a+ledger.cost(n),0))}\nДата: ${d.day}`;
  if(s.op==='dismantle') return `Разбор: #${d.item} ${ledger.item(d.item).name}\n${d.parts.map((p,i)=>`${i+1}. ${p.name} · выставить ${rub(p.price)}`).join('\n')}\nОбщая выручка при продаже всего: ${rub(d.parts.reduce((a,p)=>a+p.price,0))}\nСебестоимость ПК: ${rub(ledger.cost(d.item))}\nПрогноз прибыли: ${rub(d.parts.reduce((a,p)=>a+p.price,0)-ledger.cost(d.item))}\nДата: ${d.day}`;
  return 'Отменить последнюю записанную операцию?';
}
export function reply(ledger, text) {
  const aliases={'/start':'Меню','/help':'ℹ️ Помощь','/stock':'📦 Склад','/report':'📊 Отчёт','/cancel':'Отмена','/export':'Выгрузка'};
  text=aliases[text] || text;
  if(text==='МЕНЮ') text='Меню';
  if(text==='🔄 Avito') text='Обновить Avito';
  const s=ledger.get('session');
  if(text==='Обновить Avito') {
    if(s) return {text:'Сначала закончи текущий ввод или нажми «Отмена». Затем можно обновить Avito.',keyboard:[['Отмена'],['МЕНЮ']]};
    const pending=ledger.get('avito_refresh_requested',false);
    ledger.set('avito_refresh_requested',true);
    return {text:pending?'Обновление Avito уже запрошено.':'Загружаю объявления Avito. Покажу только активные, ещё не добавленные в учёт, включая пропущенные.',keyboard:[]};
  }
  if(text==='/menu') return s ? (s.confirm ? {text:summary(ledger,s)+'\n\nЗаписать?',keyboard:[['Подтвердить'],['Назад','Отмена']]} : question(s)) : {text:'Что делаем?',keyboard:menu};
  if(text==='Меню') return {text:'Главное меню:',keyboard:menu};
  if(s && !s.confirm && text==='Назад') {
    if(s.step===0) { ledger.set('session',null); return {text:'Ввод отменён. Выбери действие.',keyboard:menu}; }
    const [field]=s.fields[--s.step]; delete s.data[field];
    if(field==='part_price' && s.data.parts?.length) s.data.parts.pop();
    ledger.set('session',s); return question(s);
  }
  if(text==='Отмена') { ledger.set('session',null); return {text:'Ввод отменён. Выбери действие.',keyboard:menu}; }
  if(text==='Помощь') return {text:help,keyboard:s ? [['Отмена']] : moreMenu};
  const pretty={'📥 Купить':'Купил','💰 Продать':'Продал','🔄 Avito':'Обновить Avito','📦 Склад':'Склад','🧹 Очистить':'Очистить склад','📈 Статистика':'Статистика','⚠️ Залежались':'Залежались','📊 Отчёт':'Отчёт','🗓 За месяц':'Отчёт за месяц','ℹ️ Помощь':'Помощь'};
  text=pretty[text] || text;
  if(text==='Назад') return {text:'Главное меню:',keyboard:menu};
  if(text==='Склад') return {text:ledger.stock()+'\n\nВыбери товар для действий:',keyboard:stockMenu(ledger)};
  if(text==='Очистить склад') { const count=ledger.all().filter(r=>!r.parent&&!r.sold_on&&!r.dismantled).length; assert(count>0,'Склад уже пуст.'); const ns={op:'clear_stock',confirm:true,fields:[],step:0,data:{count}}; ledger.set('session',ns); return {text:`Удалить весь текущий склад? Позиций: ${count}.\nПроданные сделки и отчёты останутся.`,keyboard:[['Подтвердить'],['Отмена']]}; }
  let delivery=text.match(/^(Продан без доставки|В доставке|Снял без продажи) #([1-9]\d*)$/);
  if(!s && delivery) {
    const n=Number(delivery[2]); ledger.available(n);
    if(delivery[1]==='Продан без доставки') return {text:ledger.itemCard(n)+'\n\nПодтвердить продажу по последней цене объявления?',keyboard:[[`Подтвердить продажу #${n}`],['Отмена']]};
    if(delivery[1]==='В доставке') { const ns={op:'dispatch',fields:[['amount','Сколько должен получить после доставки? Введи сумму в рублях.']],step:0,data:{item:n}}; ledger.set('session',ns); return question(ns); }
    return {text:ledger.itemCard(n)+'\n\nУбрать со склада без дохода?',keyboard:[[`Подтвердить снятие #${n}`],['Отмена']]};
  }
  let done=text.match(/^Подтвердить продажу #([1-9]\d*)$/); if(!s&&done) { const ns={op:'confirmListingSale',confirm:true,fields:[],step:0,data:{item:Number(done[1]),day:today()}}; ledger.set('session',ns); return {text:'Подтвердить завершённую продажу?',keyboard:[['Подтвердить'],['Отмена']]}; }
  let hide=text.match(/^Подтвердить снятие #([1-9]\d*)$/); if(!s&&hide) { const ns={op:'hideListing',confirm:true,fields:[],step:0,data:{item:Number(hide[1])}}; ledger.set('session',ns); return {text:'Подтвердить снятие без продажи?',keyboard:[['Подтвердить'],['Отмена']]}; }
  let got=text.match(/^Покупатель забрал #([1-9]\d*)$/); if(!s&&got) { const n=Number(got[1]); ledger.available(n); const ns={op:'receive',confirm:true,fields:[],step:0,data:{item:n,day:today()}}; ledger.set('session',ns); return {text:'Подтвердить: покупатель получил товар?',keyboard:[['Подтвердить'],['Отмена']]}; }
  let back=text.match(/^Возврат #([1-9]\d*)$/); if(!s&&back) { const n=Number(back[1]); ledger.available(n); const ns={op:'returnDelivery',confirm:true,fields:[],step:0,data:{item:n}}; ledger.set('session',ns); return {text:'Подтвердить возврат товара на склад?',keyboard:[['Подтвердить'],['Отмена']]}; }
  let product=text.match(/^Товар #([1-9]\d*) · /);
  if(!s && product) {
    const n=Number(product[1]); const r=ledger.available(n);
    const deliveryButtons=r.fulfillment==='in_transit'
      ? [[`Покупатель забрал #${n}`],[`Возврат #${n}`]]
      : [[`В доставке #${n}`]];
    return {text:ledger.itemCard(n)+'\n\nЧто сделать?',url:r.avito_url,
      keyboard:[...deliveryButtons,[`Переименовать #${n}`],[`Удалить #${n}`],['Склад']]};
  }
  let action=text.match(/^(Продать|Переименовать|Удалить) #([1-9]\d*)$/);
  if(!s && action) { const n=Number(action[2]); ledger.available(n); if(action[1]==='Продать') return reply(ledger,`Продать #${n} · ${ledger.item(n).name}`); if(action[1]==='Переименовать') { const ns={op:'rename',fields:[['name','Новое название товара?']],step:0,data:{item:n}}; ledger.set('session',ns); return question(ns); } const ns={op:'remove',confirm:true,fields:[],step:0,data:{item:n}}; ledger.set('session',ns); return {text:`Удалить #${n} ${ledger.item(n).name}?`,keyboard:[['Подтвердить'],['Отмена']]}; }
  if(text==='Статистика' || text==='📈 Статистика') return {text:ledger.avitoDashboard(),keyboard:menu};
  if(text==='Залежались') {
    const rows=ledger.staleListings(7);
    return {text:rows.length ? `⚠️ ЗАЛЕЖАЛИСЬ · больше 7 дней\n\n${rows.map(r=>`#${r.item_id} ${r.title}\n${r.ageDays} дн. · ${rub(Math.round(r.price*100))}`).join('\\n\\n')}\n\nОткрой карточку товара на складе и измени цену вручную.` : '✅ Залежавшихся объявлений нет.', keyboard:menu};
  }
  if(text==='Отчёт' || text==='Отчёт за месяц') return {text:ledger.report(text==='Отчёт за месяц'?today().slice(0,7):null),keyboard:s ? [['Отмена']] : menu};
  if(text==='Выгрузка') return {text:'Выгрузка учёта. Суммы внутри файла — в копейках.',document:ledger.export(),keyboard:menu};
  let av=text.match(/^Добавить Avito #([0-9]+)$/);
  if(av) {
    const a=ledger.avito(Number(av[1])); assert(a,'Объявление Avito не найдено.');
    assert(!ledger.hasAvitoItem(a.id),'Это объявление уже добавлено в учёт. Дубль не создан.');
    if(s) { queueAvito(ledger,a.id); return {text:`${a.title} поставил в очередь. Сначала закончи текущий товар — потом бот спросит закупку по этой карточке.`,keyboard:[['Назад','Отмена']]}; }
    const next={op:'buy',fields:[],step:0,confirm:true,data:{kind:'purchase',name:a.title,cost:0,acquired:today(),avito_id:a.id,avito_url:a.url}};
    ledger.set('session',next); return {text:`${a.title}\nЦена продажи на Avito: ${rub(a.price*100)}\n${a.url}\n\nДобавить в склад с себестоимостью 0 ₽?`,keyboard:[['Подтвердить'],['Отмена']]};
  }
  av=text.match(/^Пропустить Avito #([0-9]+)$/);
  if(av) { ledger.db.prepare('UPDATE avito_items SET handled=1 WHERE id=?').run(Number(av[1])); nextAvito(ledger); return {text:'Пропустил. Показываю следующее объявление.',keyboard:s?[['Назад','Отмена']]:menu}; }
  const chosen=text.match(/^(Продать|Расход) #([1-9]\d*)\s*·/);
  if(!s && chosen) {
    const op=chosen[1]==='Продать'?'sell':'expense', item=Number(chosen[2]); ledger.available(item);
    const fields=op==='sell'?[['amount','За сколько продал? Введи цену в рублях.'],['day','Дата продажи? «Сегодня» или ГГГГ-ММ-ДД.']]:[['amount','Сколько потратил? Введи сумму в рублях.'],['note','На что потратил?'],['day','Дата расхода? «Сегодня» или ГГГГ-ММ-ДД.']];
    const next={op,fields,step:0,data:{item}}; ledger.set('session',next); return question(next);
  }
  if(s) {
    if(s.confirm) {
      if(text==='Назад') { s.confirm=false; const [field]=s.fields[--s.step]; delete s.data[field]; if(field==='part_price'&&s.data.parts?.length) s.data.parts.pop(); ledger.set('session',s); return question(s); }
      if(text!=='Подтвердить') return {text:'Нажми «Подтвердить» или «Отмена».',keyboard:[['Подтвердить','Отмена']]};
      const result=s.op==='undo' ? ledger.undo() : s.op==='quick_expense' ? ledger.expense({item:0,amount:s.data.amount,note:'Быстрый расход',day:s.data.day}) : s.op==='remove' ? ledger.removeItem(s.data.item) : s.op==='rename' ? ledger.renameItem(s.data.item,s.data.name) : s.op==='clear_stock' ? ledger.clearStock() : ledger[s.op](s.data);
      ledger.set('session',null);
      if(s.op==='buy' && s.data.avito_id) {
        const q=ledger.get('avito_queue',[]); const next=q.shift(); ledger.set('avito_queue',q);
        if(next && !ledger.hasAvitoItem(next)) {
          const a=ledger.avito(next); const ns={op:'buy',fields:[],step:0,confirm:true,data:{kind:'purchase',name:a.title,cost:0,acquired:today(),avito_id:a.id,avito_url:a.url}};
          ledger.set('session',ns); return {text:`${result}\n\nСледующее объявление:\n${a.title}\nЦена на Avito: ${rub(a.price*100)} ₽\n\nДобавить в склад с себестоимостью 0 ₽?`,keyboard:[['Подтвердить'],['Отмена']]};
        }
        nextAvito(ledger);
      }
      if(s.op==='dispatch') return {text:result,keyboard:[[`Покупатель забрал #${s.data.item}`],[`Возврат #${s.data.item}`],['Склад']]};
      return {text:result,keyboard:menu};
    }
    const [field]=s.fields[s.step];
    let value=text;
    if(['cost','amount'].includes(field)) value=money(text);
    else if(['day','acquired'].includes(field)) value=date(text);
    else if(field==='item') {
      value=s.op==='expense' && text==='0' ? 0 : id(text);
      if(value) s.op==='sell' ? ledger.available(value) : ledger.item(value);
    } else if(field==='ids') {
      value=text.split(/[,;\s]+/).filter(Boolean).map(id);
      assert(value.length>=2 && new Set(value).size===value.length,'Нужно минимум две разные детали.');
      value.forEach(n=>{assert(ledger.available(n).kind!=='build','Нужны отдельные детали, не другая сборка.');});
    } else if(field==='count') {
      assert(/^\d{1,2}$/.test(text) && Number(text)>=2 && Number(text)<=30,'Введи число от 2 до 30.');
      value=Number(text); s.data.parts=[];
    } else if(field==='part_name') {
      assert(text.length>=1 && text.length<=120,'Название от 1 до 120 символов.'); value=text;
    } else if(field==='part_price') {
      value=money(text); s.data.parts.push({name:s.data.part_name,price:value}); delete s.data.part_name; delete s.data.part_price;
      if(s.data.parts.length < s.data.count) { s.fields.splice(s.step+1,0,['part_name',`Название комплектующей №${s.data.parts.length+1}?`],['part_price',`Цена выставления №${s.data.parts.length+1} в рублях?`]); }
    } else assert(text.length>=1 && text.length<=160,'Введи от 1 до 160 символов.');
    if(s.op==='quick_expense') { assert(value>0,'Сумма должна быть больше нуля.'); s.data.day=today(); }
    if(field==='amount' && s.op==='expense') assert(value>0,'Расход должен быть больше нуля.');
    if(field==='day' && s.op==='sell') assert(value>=ledger.item(s.data.item).acquired,'Продажа не может быть раньше покупки/сборки.');
    if(field==='day' && s.op==='build') assert(s.data.ids.every(n=>ledger.item(n).acquired<=value),'Сборка не может быть раньше покупки деталей.');
    if(field==='day' && s.op==='dismantle') assert(value>=ledger.item(s.data.item).acquired,'Разбор не может быть раньше покупки/сборки.');
    s.data[field]=value;
    s.step++;
    if(s.step===s.fields.length) { s.confirm=true; ledger.set('session',s); return {text:summary(ledger,s)+'\n\nЗаписать?',keyboard:[['Подтвердить','Отмена']]}; }
    ledger.set('session',s);
    return question(s);
  }
  if(text==='Отменить действие' || text==='Отменить запись') {
    assert(ledger.get('undo'),'Нет операции для отмены.');
    const j=ledger.db.prepare('SELECT action,created FROM journal WHERE id=?').get(ledger.get('undo'));
    ledger.set('session',{op:'undo',confirm:true});
    return {text:`Отменить последнюю запись «${j.action}» (${j.created})?`,keyboard:[['Подтвердить','Отмена']]};
  }
  if(flows[text]) {
    const f=flows[text];
    if(text==='Продал' || text==='Расход') return {text:'Выбери товар:',keyboard:stockButtons(ledger,text==='Продал'?'Продать':'Расход')};
    const next={op:f.op,fields:f.fields,step:0,data:f.kind?{kind:f.kind}:{}};
    ledger.set('session',next);
    return question(next);
  }
  return {text:'Выбери действие кнопкой. Свободную речь и голосовые пока не разбираю.',keyboard:menu};
}

export function processUpdate(ledger, update, pairingCode) {
  if(ledger.db.prepare('SELECT id FROM processed WHERE id=?').get(update.update_id)) return;
  ledger.db.exec('BEGIN IMMEDIATE');
  try {
    let m=update.message, callbackText='';
    let callbackResult;
    if(update.callback_query) {
      const q=update.callback_query;
      callbackResult=resolveCallback(ledger,q);
      if(callbackResult.error) { callbackText=callbackResult.error; m=null; }
      else m={chat:q.message.chat,from:q.from,text:callbackResult.command || ''};
    }
    if(m?.chat?.type==='private' && m.from?.id===m.chat.id && !m.from.is_bot) {
      let owner=ledger.get('owner');
      let result;
      if(!owner && m.text===`/start ${pairingCode}`) {
        ledger.set('owner',m.from.id); owner=m.from.id;
        result={text:'Привязка готова. Учёт доступен только тебе.\n\nНачни с кнопки «Было в наличии»: занеси товары, которые уже лежат у тебя.',keyboard:menu};
      } else if(owner===m.from.id) {
        try { result=callbackResult?.payload || reply(ledger,(m.text || '').trim()); }
        catch(e) { if(!(e instanceof InputError)) throw e; result={text:e.message,keyboard:ledger.get('session')?.confirm?[['Назад','Подтвердить','Отмена']]:ledger.get('session')?[['Назад','Отмена']]:menu}; }
      }
      if(result) ledger.db.prepare('INSERT INTO outbox(chat,payload) VALUES(?,?)').run(m.chat.id,JSON.stringify(result));
    }
    ledger.db.prepare('INSERT INTO processed VALUES(?)').run(update.update_id);
    ledger.set('offset',update.update_id+1);
    ledger.db.exec('COMMIT');
    return {callbackText};
  } catch(e) { ledger.db.exec('ROLLBACK'); throw e; }
}
