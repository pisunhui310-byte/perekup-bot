import { DatabaseSync } from 'node:sqlite';

export class InputError extends Error {}
export const assert = (condition, message) => { if (!condition) throw new InputError(message); };
export const today = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
export const rub = cents => new Intl.NumberFormat('ru-RU', {style:'currency', currency:'RUB'}).format(cents / 100);
export function money(text) {
  const s = text.replace(/\s/g, '').replace(',', '.');
  assert(/^\d{1,9}(\.\d{1,2})?$/.test(s), 'Введи сумму в рублях: например 15000 или 15000,50.');
  const [a, b = ''] = s.split('.');
  return Number(a) * 100 + Number(b.padEnd(2, '0'));
}
export function date(text) {
  const s = text.toLowerCase() === 'сегодня' ? today() : text;
  assert(/^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s && s <= today(), 'Дата: ГГГГ-ММ-ДД (не в будущем) или «Сегодня».');
  return s;
}
export function id(text) {
  assert(/^#?[1-9]\d{0,8}$/.test(text), 'Введи номер товара из «Склада», например 12.');
  return Number(text.replace('#', ''));
}

export class Ledger {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS items(
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('purchase','opening','build')),
        cost INTEGER NOT NULL CHECK(cost>=0), acquired TEXT NOT NULL,
        parent INTEGER REFERENCES items(id), sold_on TEXT, sale INTEGER CHECK(sale>=0), dismantled INTEGER NOT NULL DEFAULT 0, source_id INTEGER REFERENCES items(id), avito_id INTEGER, avito_url TEXT);
      CREATE TABLE IF NOT EXISTS expenses(
        id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER REFERENCES items(id),
        amount INTEGER NOT NULL CHECK(amount>0), note TEXT NOT NULL, day TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal(
        id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, before_json TEXT NOT NULL, created TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS processed(id INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, chat INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS avito_items(id INTEGER PRIMARY KEY, title TEXT NOT NULL, price INTEGER NOT NULL, url TEXT NOT NULL, status TEXT NOT NULL, seen_at TEXT NOT NULL, first_seen_at TEXT, handled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS avito_stats(item_id INTEGER PRIMARY KEY, views INTEGER NOT NULL DEFAULT 0, contacts INTEGER NOT NULL DEFAULT 0, favorites INTEGER NOT NULL DEFAULT 0, orders INTEGER NOT NULL DEFAULT 0, spend INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
    `);
    const cols=this.db.prepare('PRAGMA table_info(items)').all().map(r=>r.name);
    if(!cols.includes('dismantled')) this.db.exec('ALTER TABLE items ADD COLUMN dismantled INTEGER NOT NULL DEFAULT 0');
    if(!cols.includes('source_id')) this.db.exec('ALTER TABLE items ADD COLUMN source_id INTEGER REFERENCES items(id)');
    if(!cols.includes('avito_id')) this.db.exec('ALTER TABLE items ADD COLUMN avito_id INTEGER');
    if(!cols.includes('avito_url')) this.db.exec('ALTER TABLE items ADD COLUMN avito_url TEXT');
    const avitoCols=this.db.prepare('PRAGMA table_info(avito_items)').all().map(r=>r.name);
    if(!avitoCols.includes('first_seen_at')) this.db.exec('ALTER TABLE avito_items ADD COLUMN first_seen_at TEXT');
    this.db.exec('UPDATE avito_items SET first_seen_at=COALESCE(first_seen_at,seen_at) WHERE first_seen_at IS NULL');
    for(const [column,type] of [['listing_price','INTEGER'],['fulfillment',"TEXT NOT NULL DEFAULT 'listed'"],['expected_payout','INTEGER'],['sale_source','TEXT']]) {
      if(!cols.includes(column)) this.db.exec(`ALTER TABLE items ADD COLUMN ${column} ${type}`);
    }
    this.db.exec(`UPDATE items SET listing_price=(SELECT CAST(ROUND(a.price*100) AS INTEGER) FROM avito_items a WHERE a.id=items.avito_id)
      WHERE listing_price IS NULL AND avito_id IS NOT NULL`);
  }
  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key, value) { this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  all() { return this.db.prepare('SELECT * FROM items ORDER BY id').all(); }
  expenses() { return this.db.prepare('SELECT * FROM expenses ORDER BY id').all(); }
  avito(id) { return this.db.prepare('SELECT * FROM avito_items WHERE id=?').get(id); }
  hasAvitoItem(id) { return !!this.db.prepare('SELECT 1 FROM items WHERE avito_id=? LIMIT 1').get(id); }
  avitoStat(id) { return this.db.prepare('SELECT * FROM avito_stats WHERE item_id=?').get(id); }
  setAvitoStat(id,s) { this.db.prepare(`INSERT INTO avito_stats(item_id,views,contacts,favorites,orders,spend,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET views=excluded.views,contacts=excluded.contacts,favorites=excluded.favorites,orders=excluded.orders,spend=excluded.spend,updated_at=excluded.updated_at`).run(id,s.views||0,s.contacts||0,s.favorites||0,s.orders||0,s.spend||0,new Date().toISOString()); }
  avitoDashboard() {
    const ads=this.db.prepare('SELECT * FROM avito_items ORDER BY status,title').all();
    const rows=ads.map(a=>{const s=this.avitoStat(a.id)||{};return {a,s};});
    const sum=k=>rows.reduce((n,r)=>n+(r.s[k]||0),0);
    const access=this.get('stats_access');
    const notice=access==='forbidden' ? '\n\n⚠️ Avito не дал доступ к Statistics API (403). Поэтому цифры не нулевые, а пока недоступны. Проверь права приложения.' : access==='error' ? '\n\n⚠️ Statistics API вернул ошибку. Нажми 🔄 Avito ещё раз.' : access==='empty' ? '\n\nℹ️ Avito вернул пустую статистику за последние 30 дней.' : '';
    return `📈 AVITO · ВОРОНКА\nОбъявлений: ${ads.length}\nАктивных: ${ads.filter(a=>a.status==='active').length}\nПросмотры: ${sum('views')}\nКонтакты: ${sum('contacts')}\nИзбранное: ${sum('favorites')}\nЗаказы: ${sum('orders')}\nПродвижение: ${rub(sum('spend'))}${notice}\n\n`+(rows.slice(0,12).map(({a,s})=>`${a.title}\n${s.views||0} просмотров · ${s.contacts||0} контактов · ${s.orders||0} заказов · ${rub(s.spend||0)}`).join('\n\n')||'Нажми 🔄 Avito для загрузки объявлений.');
  }
  staleListings(days = 7) {
    const cutoff = Date.now() - days * 86400000;
    return this.db.prepare(`SELECT a.*, i.id AS item_id, i.listing_price, i.fulfillment
      FROM avito_items a JOIN items i ON i.avito_id=a.id
      WHERE a.status='active' AND i.sold_on IS NULL AND i.dismantled=0
      ORDER BY a.seen_at ASC`).all().filter(r => {
      const t = Date.parse(r.first_seen_at || r.seen_at); return Number.isFinite(t) && t <= cutoff;
    }).map(r => ({...r, ageDays: Math.max(0, Math.floor((Date.now()-Date.parse(r.first_seen_at || r.seen_at))/86400000))}));
  }
  expenseBreakdown(month = null) {
    const rows = this.expenses().filter(e => !month || e.day.startsWith(month));
    const groups = new Map();
    for (const e of rows) { const key = e.note.trim().toLowerCase() || 'без категории'; groups.set(key, (groups.get(key)||0) + e.amount); }
    return [...groups].sort((a,b)=>b[1]-a[1]);
  }
  item(n) {
    const r = this.db.prepare('SELECT * FROM items WHERE id=?').get(n);
    assert(r, `Товар #${n} не найден.`);
    return r;
  }
  available(n) {
    const r = this.item(n);
    assert(!r.parent && !r.sold_on && !r.dismantled && r.fulfillment!=='archived', `#${n} уже продан, удалён или входит в сборку.`);
    return r;
  }
  cost(n) {
    return this.item(n).cost + this.db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE item_id=?').get(n).total
      + this.db.prepare('SELECT id FROM items WHERE parent=?').all(n).reduce((sum, child) => sum + this.cost(child.id), 0);
  }
  snapshot() { return {items:this.all(), expenses:this.expenses()}; }
  mutate(action, f) {
    this.db.exec('SAVEPOINT change');
    try {
      const before = JSON.stringify(this.snapshot());
      const result = f();
      const j = this.db.prepare('INSERT INTO journal(action,before_json,created) VALUES(?,?,?)').run(action, before, new Date().toISOString());
      this.set('undo', Number(j.lastInsertRowid));
      this.db.exec('RELEASE change');
      return result;
    } catch(e) { this.db.exec('ROLLBACK TO change; RELEASE change'); throw e; }
  }
  buy(d) {
    return this.mutate('Добавление товара', () => {
      if(d.avito_id) assert(!this.hasAvitoItem(d.avito_id), 'Это объявление уже добавлено в учёт. Повторная покупка не создана.');
      assert(d.name.trim().length > 0 && d.name.length <= 160, 'Название: от 1 до 160 символов.');
      assert(Number.isSafeInteger(d.cost) && d.cost >= 0, 'Некорректная стоимость.');
      date(d.acquired);
      assert(['purchase','opening'].includes(d.kind), 'Некорректный тип покупки.');
      const r = this.db.prepare('INSERT INTO items(name,kind,cost,acquired,avito_id,avito_url) VALUES(?,?,?,?,?,?)').run(d.name,d.kind,d.cost,d.acquired,d.avito_id||null,d.avito_url||null);
      if(d.avito_id) {
        const a=this.avito(d.avito_id);
        if(a) this.db.prepare('UPDATE items SET listing_price=? WHERE id=?').run(Math.round(a.price*100),r.lastInsertRowid);
      } else if (d.listing_price !== undefined) this.db.prepare('UPDATE items SET listing_price=? WHERE id=?').run(d.listing_price,r.lastInsertRowid);
      return `Добавлен #${r.lastInsertRowid}: ${d.name}.`;
    });
  }
  sell(d) {
    return this.mutate('Продажа', () => {
      const r = this.available(d.item);
      assert(date(d.day) >= r.acquired, 'Продажа не может быть раньше покупки/сборки.');
      assert(Number.isSafeInteger(d.amount) && d.amount >= 0, 'Некорректная сумма.');
      this.db.prepare('UPDATE items SET sold_on=?,sale=? WHERE id=?').run(d.day,d.amount,d.item);
      return `Продан #${d.item}: ${r.name}.\nРезультат сделки: ${rub(d.amount - this.cost(d.item))}. Общие расходы учитываются в отчёте отдельно.`;
    });
  }
  expense(d) {
    return this.mutate('Расход', () => {
      if (d.item) this.item(d.item);
      assert(Number.isSafeInteger(d.amount) && d.amount > 0, 'Расход должен быть больше нуля.');
      assert(d.note.trim() && d.note.length <= 160, 'Укажи назначение расхода (до 160 символов).');
      date(d.day);
      this.db.prepare('INSERT INTO expenses(item_id,amount,note,day) VALUES(?,?,?,?)').run(d.item || null,d.amount,d.note,d.day);
      return `Расход ${rub(d.amount)} записан${d.item ? ` на товар #${d.item}` : ' в общие расходы'}.`;
    });
  }
  build(d) {
    return this.mutate('Сборка ПК', () => {
      assert(d.name.trim() && d.name.length <= 160, 'Название: от 1 до 160 символов.');
      assert(d.ids.length >= 2 && new Set(d.ids).size === d.ids.length, 'Укажи минимум две разные детали.');
      const parts = d.ids.map(n => this.available(n));
      assert(parts.every(p => p.kind !== 'build'), 'Сборку нельзя вложить в другую сборку.');
      date(d.day);
      assert(parts.every(p => p.acquired <= d.day), 'Дата сборки не может быть раньше покупки деталей.');
      const r = this.db.prepare("INSERT INTO items(name,kind,cost,acquired) VALUES(?,'build',0,?)").run(d.name,d.day);
      const n = Number(r.lastInsertRowid);
      for (const p of parts) this.db.prepare('UPDATE items SET parent=? WHERE id=?').run(n,p.id);
      return `Собран #${n}: ${d.name}. Себестоимость ${rub(this.cost(n))}. Детали отдельно в остатках больше не считаются.`;
    });
  }
  dismantle(d) { return this.mutate('Разбор ПК', () => {
    const source=this.available(d.item); assert(source.kind==='build' || /пк|комп/i.test(source.name), 'Для разбора выбери целый ПК, а не отдельную деталь.');
    date(d.day); assert(source.acquired<=d.day, 'Дата разбора не может быть раньше покупки.');
    assert(d.parts.length>=2 && new Set(d.parts.map(p=>p.name.toLowerCase())).size===d.parts.length, 'Нужно минимум две детали с разными названиями.');
    const totalPrice=d.parts.reduce((s,p)=>s+p.price,0); assert(totalPrice>0, 'Общая цена комплектующих должна быть больше нуля.');
    const sourceCost=this.cost(source.id); let allocated=0;
    this.db.prepare('UPDATE items SET dismantled=1 WHERE id=?').run(source.id);
    d.parts.forEach((p,i)=>{ const cost=i===d.parts.length-1 ? sourceCost-allocated : Math.round(sourceCost*p.price/totalPrice); allocated+=cost; this.db.prepare("INSERT INTO items(name,kind,cost,acquired,source_id) VALUES(?,'purchase',?,?,?)").run(p.name,cost,d.day,source.id); });
    return `Разобран #${source.id}: ${source.name}.\nСоздано деталей: ${d.parts.length}. Общая выручка при продаже всего ${rub(totalPrice)}.\nПрогноз прибыли: ${rub(totalPrice-sourceCost)}.`;
  }); }
  removeItem(n) { return this.mutate('Удаление товара', () => { const r=this.available(n); assert(!this.db.prepare('SELECT 1 FROM items WHERE source_id=?').get(n), 'У товара есть связанные детали.'); this.db.prepare('DELETE FROM expenses WHERE item_id=?').run(n); this.db.prepare('DELETE FROM items WHERE id=?').run(n); return `Удалён #${n}: ${r.name}.`; }); }
  renameItem(n,name) { return this.mutate('Изменение товара', () => { const r=this.available(n); assert(name.trim() && name.length<=160,'Название от 1 до 160 символов.'); this.db.prepare('UPDATE items SET name=? WHERE id=?').run(name.trim(),n); return `Переименован #${n}: ${r.name} → ${name.trim()}.`; }); }
  clearStock() { return this.mutate('Очистка склада', () => { const rows=this.db.prepare('SELECT id FROM items WHERE parent IS NULL AND sold_on IS NULL AND dismantled=0').all(); assert(rows.length>0,'Склад уже пуст.'); for(const r of rows) { this.db.prepare('DELETE FROM expenses WHERE item_id=?').run(r.id); this.db.prepare('DELETE FROM items WHERE id=?').run(r.id); } return `Склад очищен. Удалено позиций: ${rows.length}. Проданные сделки сохранены.`; }); }
  sellFromAvito(avitoId, price, day) { return this.mutate('Продажа через Avito', () => { const r=this.db.prepare('SELECT * FROM items WHERE avito_id=? AND sold_on IS NULL AND dismantled=0 LIMIT 1').get(avitoId); assert(r,'Связанный товар не найден или уже продан.'); assert(Number.isFinite(price)&&price>=0,'Некорректная цена Avito.'); this.db.prepare('UPDATE items SET sold_on=?,sale=? WHERE id=?').run(day,Math.round(price*100),r.id); return `Avito отметил объявление проданным: #${r.id} ${r.name} за ${rub(Math.round(price*100))}.`; }); }
  dispatch(d) { return this.mutate('Отправка покупателю',()=>{
    this.available(d.item);
    assert(Number.isSafeInteger(d.amount) && d.amount>=0,'Введи сумму к получению.');
    if (d.fee > 0) this.db.prepare('INSERT INTO expenses(item_id,amount,note,day) VALUES(?,?,?,?)').run(d.item,d.fee,'Комиссия Avito / доставка',today());
    this.db.prepare("UPDATE items SET fulfillment='in_transit',expected_payout=? WHERE id=?").run(d.amount,d.item);
    return `🚚 ${this.item(d.item).name} едет к покупателю.\nК получению: ${rub(d.amount)}. В доход пока не записано.`;
  }); }
  addDeliveryFee(d) { return this.mutate('Комиссия Avito',()=>{ const r=this.item(d.item); assert(r.fulfillment==='in_transit','Комиссию можно добавить только товару в доставке.'); assert(Number.isSafeInteger(d.fee)&&d.fee>=0,'Комиссия не может быть отрицательной.'); this.db.prepare('INSERT INTO expenses(item_id,amount,note,day) VALUES(?,?,?,?)').run(r.id,d.fee,'Комиссия Avito / доставка',today()); return `Комиссия Avito записана: ${rub(d.fee)}.`; }); }
  receive(d) { return this.mutate('Получение покупателем',()=>{
    const r=this.available(d.item);
    assert(r.fulfillment==='in_transit','Товар не отмечен в доставке.');
    assert(Number.isSafeInteger(r.expected_payout),'Укажи сумму к получению.');
    const day=date(d.day); assert(day>=r.acquired,'Дата получения раньше добавления товара.');
    this.db.prepare("UPDATE items SET fulfillment='received',sold_on=?,sale=?,sale_source='delivery_confirmed' WHERE id=?").run(day,r.expected_payout,r.id);
    return `✅ ${r.name}: покупатель забрал.\nДоход ${rub(r.expected_payout)} записан на ${day}. Товар убран со склада.`;
  }); }
  returnDelivery(d) { return this.mutate('Возврат доставки',()=>{
    const r=this.available(d.item); assert(r.fulfillment==='in_transit','Нет активной доставки.');
    this.db.prepare("UPDATE items SET fulfillment='listed',expected_payout=NULL WHERE id=?").run(r.id);
    return 'Возврат отмечен. Товар снова на складе, доход не начислен.';
  }); }
  confirmListingSale(d) { return this.mutate('Продажа без доставки',()=>{
    const r=this.available(d.item); assert(r.fulfillment==='pending','Снятое объявление уже обработано.');
    assert(Number.isSafeInteger(r.listing_price),'Цена объявления неизвестна.');
    this.db.prepare("UPDATE items SET sold_on=?,sale=?,fulfillment='received',sale_source='listing_confirmed' WHERE id=?")
      .run(date(d.day || today()),r.listing_price,r.id);
    return `✅ ${r.name}: доход ${rub(r.listing_price)} записан по последней цене объявления.`;
  }); }
  hideListing(d) { return this.mutate('Снятие без продажи',()=>{
    const r=this.available(d.item); assert(r.fulfillment!=='in_transit','Сначала отметь результат доставки.');
    this.db.prepare("UPDATE items SET fulfillment='archived' WHERE id=?").run(r.id);
    return 'Товар убран со склада без начисления дохода. История расходов сохранена.';
  }); }
  stockItems() { return this.all().filter(r=>!r.parent&&!r.sold_on&&!r.dismantled&&r.fulfillment!=='archived'); }
  stockTotals() {
    const rows=this.stockItems();
    const listed=rows.filter(r=>r.fulfillment==='listed');
    const transit=rows.filter(r=>r.fulfillment==='in_transit');
    return {listed:listed.reduce((s,r)=>s+(r.listing_price || 0),0),transit:transit.reduce((s,r)=>s+(r.expected_payout || 0),0),unknown:listed.filter(r=>r.listing_price===null).length};
  }
  itemCard(n) {
    const r=this.item(n);
    const state={listed:'📦 На продаже',in_transit:'🚚 Едет к покупателю',pending:'⏳ Снято — уточни результат',inactive:'⏸ Объявление неактивно',archived:'Убрано со склада',received:'✅ Продано'}[r.fulfillment];
    return `${r.name}\n${r.sold_on?'✅ Продано':state}\nЦена объявления: ${r.listing_price===null?'ещё не получена':rub(r.listing_price)}`+
      (r.fulfillment==='in_transit'?`\nК получению: ${rub(r.expected_payout || 0)}\nДоход будет записан после получения покупателем.`:'')+
      (r.avito_url?`\n${r.avito_url}`:'');
  }
  undo() {
    const entry = this.db.prepare('SELECT * FROM journal WHERE undone=0 ORDER BY id DESC LIMIT 1').get();
    const n = entry?.id;
    assert(n, 'Нет подтверждённых действий для отмены.');
    const s = JSON.parse(entry.before_json);
    this.db.exec('SAVEPOINT restore');
    try {
      this.db.exec('DELETE FROM expenses; UPDATE items SET parent=NULL,source_id=NULL; DELETE FROM items;');
      const insert = this.db.prepare('INSERT INTO items(id,name,kind,cost,acquired,parent,sold_on,sale,dismantled,source_id,avito_id,avito_url) VALUES(?,?,?,?,?,NULL,?,?,?,?,?,?)');
      for (const r of s.items) insert.run(r.id,r.name,r.kind,r.cost,r.acquired,r.sold_on,r.sale,r.dismantled||0,r.source_id||null,r.avito_id||null,r.avito_url||null);
      for (const r of s.items) this.db.prepare('UPDATE items SET listing_price=?,fulfillment=?,expected_payout=?,sale_source=? WHERE id=?').run(r.listing_price??null,r.fulfillment||'listed',r.expected_payout??null,r.sale_source??null,r.id);
      for (const r of s.items) if (r.parent) this.db.prepare('UPDATE items SET parent=? WHERE id=?').run(r.parent,r.id);
      for (const r of s.expenses) this.db.prepare('INSERT INTO expenses VALUES(?,?,?,?,?)').run(r.id,r.item_id,r.amount,r.note,r.day);
      this.db.prepare('UPDATE journal SET undone=1 WHERE id=?').run(n);
      const previous=this.db.prepare('SELECT id FROM journal WHERE undone=0 ORDER BY id DESC LIMIT 1').get();
      this.set('undo', previous?.id || null);
      this.db.exec('RELEASE restore');
      return `Отменена последняя запись: ${entry.action}.`;
    } catch(e) { this.db.exec('ROLLBACK TO restore; RELEASE restore'); throw e; }
  }
  stock() {
    const rows=this.stockItems(), total=this.stockTotals();
    return '📦 СКЛАД\n'+(rows.map(r=>`${r.fulfillment==='in_transit'?'🚚':r.fulfillment==='listed'?'📦':'⏳'} ${r.name} · ${r.fulfillment==='in_transit'?rub(r.expected_payout || 0):r.listing_price===null?'цена не получена':rub(r.listing_price)}`).join('\n') || 'Пока пусто. Нажми «Avito», чтобы добавить объявления.')+
      `\n\nНа продаже: ${rub(total.listed)}\nВ доставке, к получению: ${rub(total.transit)}\nВсего в товаре: ${rub(total.listed+total.transit)}`+
      (total.unknown?`\nБез известной цены: ${total.unknown} шт.`:'')+'\nЭто ожидаемые деньги, не заработанный доход.';
  }
  report(month = null) {
    const within = day => day && (!month || day.startsWith(month));
    const items = this.all(), expenses = this.expenses();
    const sales = items.filter(r => !r.parent && within(r.sold_on));
    const revenue = sales.reduce((s,r) => s+r.sale,0);
    const cogs = sales.reduce((s,r) => s+this.cost(r.id),0);
    const general = expenses.filter(r => !r.item_id && within(r.day)).reduce((s,r) => s+r.amount,0);
    const purchases = items.filter(r => r.kind==='purchase' && !r.source_id && within(r.acquired)).reduce((s,r) => s+r.cost,0);
    const cashExpenses = expenses.filter(r => within(r.day)).reduce((s,r) => s+r.amount,0);
    const totals=this.stockTotals();
    const breakdown = this.expenseBreakdown(month).slice(0,8).map(([name,amount])=>`• ${name}: ${rub(amount)}`).join('\n');
    const quick = expenses.filter(r=>!r.item_id && within(r.day));
    const quickTotal = quick.reduce((s,r)=>s+r.amount,0);
    const quickBreakdown = [...new Map(quick.map(r=>[r.note,(quick.filter(x=>x.note===r.note).reduce((s,x)=>s+x.amount,0))])).entries()]
      .sort((a,b)=>b[1]-a[1]).map(([name,amount])=>`• ${name}: ${rub(amount)}`).join('\n');
    const paid=purchases+cashExpenses, realized=revenue-cogs-general, cashResult=revenue-paid;
    return `📊 ОТЧЁТ\nПериод: ${month || 'за всё время'}\n\n`+
      `✅ ЗАВЕРШЁННЫЕ ПРОДАЖИ\nПродано: ${sales.length} шт.\nВыручка: ${rub(revenue)}\nРеализованный профит: ${rub(realized)}\n\n`+
      `💸 ДЕНЬГИ\nОплачено расходов и закупок: ${rub(paid)}\nДвижение денег: ${rub(cashResult)}\n\n`+
      `💀 ПОТРАЧЕНО\nВсего: ${rub(quickTotal)}\n${quickBreakdown || 'Пока нет быстрых трат.'}\n\n`+
      `📦 ОЖИДАЕТСЯ\nНа продаже: ${rub(totals.listed)}\nВ доставке: ${rub(totals.transit)}\nПотенциальная выручка: ${rub(totals.listed+totals.transit)}\n`+
      (breakdown ? `\nВСЕ РАСХОДЫ ПО НАЗНАЧЕНИЯМ\n${breakdown}\n` : '')+
      `\nПрофит появляется только после завершения продажи. Товары на складе и в доставке — это ещё не доход.`+
      (items.some(r=>r.cost>0)?`\n\nСтарый учёт с закупками:\nРезультат по внесённым данным: ${rub(revenue-cogs-general)}\nДвижение денег за период: ${rub(revenue-purchases-cashExpenses)}\nНе дублируй старые закупки в ПОТРАЧЕНО.`:'');
  }
  export() {
    return {version:1, exportedAt:new Date().toISOString(), currency:'RUB', amounts:'integer kopecks', ...this.snapshot(), journal:this.db.prepare('SELECT * FROM journal ORDER BY id').all()};
  }
  close() { this.db.close(); }
}
