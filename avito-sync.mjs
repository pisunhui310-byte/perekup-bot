import { rub } from './ledger.mjs';

const refreshMenu=[['Обновить Avito'],['МЕНЮ']];
function enqueue(ledger,owner,payload) {
  ledger.db.prepare('INSERT INTO outbox(chat,payload) VALUES(?,?)').run(owner,JSON.stringify(payload));
}

// Statistics API can return one row per day or nest metrics under `stats`/`data`.
// Flatten both shapes and aggregate them before saving, otherwise the dashboard
// silently stayed at zero when Avito changed the response envelope.
export function collectStats(value, inheritedId=null, out=[]) {
  if (!value || typeof value !== 'object') return out;
  const ownId=value.itemId ?? value.item_id ?? value.itemID ?? inheritedId;
  const metricKeys=['views','uniqViews','contacts','contactCount','favorites','orders','orderedItems','spend','spending'];
  if (ownId && metricKeys.some(k => Object.prototype.hasOwnProperty.call(value,k))) out.push({id:Number(ownId), row:value});
  if (Array.isArray(value)) for (const child of value) collectStats(child, inheritedId, out);
  else for (const [k,child] of Object.entries(value)) if (child && typeof child==='object' && !['itemId','item_id'].includes(k)) collectStats(child, ownId, out);
  return out;
}
function metric(row, names) {
  for (const name of names) { const n=Number(row?.[name]); if (Number.isFinite(n)) return n; }
  return 0;
}

// Apply only a fully fetched listing. Failed pagination cannot produce partial imports.
export function applyAvitoItems(ledger,items,{manual=false}={}) {
  const owner=ledger.get('owner'); if(!owner) return 0;
  ledger.db.exec('SAVEPOINT avito_sync');
  try {
    let offered=0;
    for(const a of new Map(items.map(a=>[a.id,a])).values()) {
      if(!Number.isSafeInteger(a.id) || typeof a.title!=='string' || !Number.isFinite(a.price) || a.price<0 || typeof a.url!=='string' || typeof a.status!=='string')
        throw new Error('Invalid Avito item');
      const existed=ledger.avito(a.id);
      const seenAt=new Date().toISOString();
      ledger.db.prepare(`INSERT INTO avito_items(id,title,price,url,status,seen_at,first_seen_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,price=excluded.price,url=excluded.url,status=excluded.status,seen_at=excluded.seen_at,
        first_seen_at=COALESCE(avito_items.first_seen_at,excluded.first_seen_at)`)
        .run(a.id,a.title,a.price,a.url,a.status,seenAt,seenAt);
      const linked=ledger.db.prepare('SELECT * FROM items WHERE avito_id=?').all(a.id);
      for(const item of linked) {
        ledger.db.prepare('UPDATE items SET listing_price=? WHERE id=?').run(Math.round(a.price*100),item.id);
        if(item.sold_on || item.parent || item.dismantled || ['archived','in_transit'].includes(item.fulfillment)) continue;
        if(a.status==='active') ledger.db.prepare("UPDATE items SET fulfillment='listed' WHERE id=?").run(item.id);
        else if(a.status==='removed') {
          ledger.db.prepare("UPDATE items SET fulfillment='pending' WHERE id=?").run(item.id);
          if(item.fulfillment!=='pending') enqueue(ledger,owner,{
            text:`${item.name}\nОбъявление снято. Avito не передал причину снятия или результат доставки.\nПоследняя цена: ${rub(Math.round(a.price*100))}\nКак закончилась продажа?`,
            keyboard:[[`Продан без доставки #${item.id}`],[`В доставке #${item.id}`],[`Снял без продажи #${item.id}`]],url:a.url
          });
        } else ledger.db.prepare("UPDATE items SET fulfillment='inactive' WHERE id=?").run(item.id);
      }
      // handled records a skip, not a purchase. Only actual inventory links prove import.
      if(a.status!=='active' || ledger.hasAvitoItem(a.id) || (!manual && existed)) continue;
      enqueue(ledger,owner,{
        text:`${manual?'Объявление ещё не добавлено в учёт':'Новое объявление на Avito'}:\n${a.title}\nЦена на Avito: ${rub(Math.round(a.price*100))}\n${a.url}\n\nДобавить в склад?`,
        url:a.url,keyboard:[[`Добавить Avito #${a.id}`,`Пропустить Avito #${a.id}`]]
      });
      offered++;
    }
    if(manual) enqueue(ledger,owner,{text:offered ? `Обновлено. Объявлений для добавления: ${offered}. Выбери «Добавить в учёт» под нужной карточкой.` : 'Обновлено. Активных объявлений, которые ещё не добавлены в учёт, нет.',keyboard:refreshMenu});
    ledger.db.exec('RELEASE avito_sync');
    return offered;
  } catch(e) { ledger.db.exec('ROLLBACK TO avito_sync; RELEASE avito_sync'); throw e; }
}

export async function runAvitoSync(ledger,client,now=Date.now()) {
  const manual=ledger.get('avito_refresh_requested',false);
  const owner=ledger.get('owner');
  // Avoid replacing form buttons while the owner is entering a purchase.
  if(!owner || ledger.get('session')) return;
  if(!manual && (!client || now-ledger.get('last_avito_sync',0)<=300000)) return;
  try {
    if(!client) {
      enqueue(ledger,owner,{text:'Avito не подключён. Введи ключи Avito при запуске start.cmd, затем нажми «Обновить Avito».',keyboard:refreshMenu});
      return;
    }
    const items=await client.items();
    try {
      const account=await client.account();
      const stats=await client.stats(account.id,items.map(a=>a.id));
      const totals=new Map();
      for (const entry of collectStats(stats)) {
        if (!Number.isSafeInteger(entry.id)) continue;
        const row=entry.row, prev=totals.get(entry.id)||{views:0,contacts:0,favorites:0,orders:0,spend:0};
        prev.views += metric(row,['views','uniqViews']); prev.contacts += metric(row,['contacts','contactCount']);
        prev.favorites += metric(row,['favorites']); prev.orders += metric(row,['orders','orderedItems']);
        prev.spend += metric(row,['spend','spending']); totals.set(entry.id,prev);
      }
      for (const [id,s] of totals) ledger.setAvitoStat(id,{...s,spend:Math.round(s.spend*100)});
      ledger.set('stats_access', totals.size ? 'available' : 'empty');
    } catch(e) {
      // Keep listing sync alive, but persist the reason so the UI never presents
      // an access failure as legitimate zero statistics.
      ledger.set('stats_access', e?.code === 'Avito 403' ? 'forbidden' : 'error');
      ledger.set('stats_error', e?.code || 'unknown');
    }
    // The list may contain active ads only. Absence is never proof of a sale.
    const found=new Set(items.map(a=>a.id));
    for(const item of ledger.stockItems().filter(i=>i.avito_id&&!found.has(i.avito_id))) {
      const cached=ledger.avito(item.avito_id);
      if(!cached || !client.itemStatus) continue;
      try {
        const detail=await client.itemStatus(item.avito_id);
        items.push({...cached,status:detail.status,url:detail.url || cached.url});
        found.add(item.avito_id);
      } catch { /* Keep last known state; transient failures must never create income. */ }
    }
    applyAvitoItems(ledger,items,{manual});
  } catch {
    // Do not expose credentials, transport URLs or terminate Telegram polling.
    if(manual) enqueue(ledger,owner,{text:'Не удалось обновить Avito. Проверь подключение и попробуй ещё раз. Учёт не изменён.',keyboard:refreshMenu});
    else console.error('Не удалось обновить Avito. Следующая попытка через 5 минут.');
  } finally {
    ledger.set('last_avito_sync',now);
    ledger.set('avito_refresh_requested',false);
  }
}
