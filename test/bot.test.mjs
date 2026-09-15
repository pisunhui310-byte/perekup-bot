import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, money, date, today, rub } from '../ledger.mjs';
import { processUpdate, reply } from '../conversation.mjs';

const day=today();
function buy(l,name,cost,kind='purchase') { l.buy({name,cost,kind,acquired:day}); return l.all().at(-1).id; }
function update(l,n,text,user=99,type='private') {
  processUpdate(l,{update_id:n,message:{chat:{id:user,type},from:{id:user,is_bot:false},text}},'secret-pairing');
}
test('money uses exact kopecks and rejects ambiguous shorthand',()=>{
  assert.equal(money('15 000,25'),1500025);
  assert.equal(money('0.01'),1);
  for(const text of ['15к','-5','1.234','NaN','1e5','']) assert.throws(()=>money(text));
});
test('dates reject invalid calendar days and future dates',()=>{
  assert.equal(date('Сегодня'),day);
  for(const text of ['2026-02-30','2099-01-01','15.09.2026']) assert.throws(()=>date(text));
});
test('components become one sellable PC without double counting costs or cash',t=>{
  const l=new Ledger(); t.after(()=>l.close());
  const a=buy(l,'GPU',1500000),b=buy(l,'CPU',800000);
  l.expense({item:a,amount:100000,note:'Доставка',day});
  l.build({name:'Игровой ПК',ids:[a,b],day});
  const pc=l.all().at(-1).id;
  assert.equal(l.cost(pc),2400000);
  assert.equal(l.all().filter(r=>!r.parent).length,1);
  assert.throws(()=>l.sell({item:a,amount:2000000,day}));
  l.sell({item:pc,amount:3000000,day});
  assert.match(l.report(),/Продано: 1/);
  assert.ok(l.report().includes(`Результат по внесённым данным: ${rub(600000)}`));
  assert.ok(l.report().includes(`Движение денег за период: ${rub(600000)}`));
  assert.ok(l.stock().includes(`Всего в товаре: ${rub(0)}`));
});
test('opening inventory affects margin but does not count as a new cash payment',t=>{
  const l=new Ledger();t.after(()=>l.close());
  const n=buy(l,'SSD',200000,'opening');
  l.sell({item:n,amount:300000,day});
  assert.ok(l.report().includes(`Результат по внесённым данным: ${rub(100000)}`));
  assert.ok(l.report().includes(`Движение денег за период: ${rub(300000)}`));
});
test('general expenses affect result once; unsold purchases affect cash, not sold margin',t=>{
  const l=new Ledger();t.after(()=>l.close());
  buy(l,'Stock',1000000);
  l.expense({item:0,amount:50000,note:'Реклама',day});
  assert.ok(l.report().includes(`Результат по внесённым данным: ${rub(-50000)}`));
  assert.ok(l.report().includes(`Движение денег за период: ${rub(-1050000)}`));
});
test('late component expense flows through sold assembly',t=>{
  const l=new Ledger();t.after(()=>l.close());
  const a=buy(l,'GPU',100000),b=buy(l,'CPU',100000);
  l.build({name:'PC',ids:[a,b],day});
  const pc=l.all().at(-1).id;
  l.sell({item:pc,amount:300000,day});
  l.expense({item:a,amount:10000,note:'Repair',day});
  assert.equal(l.cost(pc),210000);
  assert.ok(l.report().includes(`Результат по внесённым данным: ${rub(90000)}`));
});
test('invalid assemblies do not leave orphan items or move any inventory',t=>{
  const l=new Ledger();t.after(()=>l.close());
  const a=buy(l,'GPU',100000),b=buy(l,'CPU',100000);
  for(const ids of [[a,a],[a,999],[a]]) assert.throws(()=>l.build({name:'bad',ids,day}));
  assert.equal(l.all().length,2);
  assert.ok(l.all().every(r=>!r.parent));
  l.build({name:'PC',ids:[a,b],day});
  const pc=l.all().at(-1).id,c=buy(l,'RAM',10000);
  assert.throws(()=>l.build({name:'Nested',ids:[pc,c],day}));
});
test('undo build restores components; IDs of removed builds are not reused',t=>{
  const l=new Ledger();t.after(()=>l.close());
  const a=buy(l,'GPU',100000),b=buy(l,'CPU',100000);
  l.build({name:'PC',ids:[a,b],day});
  const pc=l.all().at(-1).id;
  l.undo();
  assert.equal(l.all().length,2);
  assert.ok(l.all().every(r=>!r.parent));
  l.undo();
  assert.equal(l.all().length,1);
  assert.ok(buy(l,'New item',10)>pc);
});
test('sale cannot be repeated; undo restores sellable item',t=>{
  const l=new Ledger();t.after(()=>l.close());
  const n=buy(l,'GPU',100000);
  l.sell({item:n,amount:120000,day});
  assert.throws(()=>l.sell({item:n,amount:150000,day}));
  l.undo();
  assert.equal(l.available(n).sale,null);
});
test('only private paired owner can read and modify records',t=>{
  const l=new Ledger();t.after(()=>l.close());
  update(l,1,'/start wrong');
  update(l,2,'/start secret-pairing',99,'group');
  assert.equal(l.get('owner'),null);
  assert.equal(l.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n,0);
  update(l,3,'/start secret-pairing');
  update(l,4,'Купил',777);
  assert.equal(l.get('owner'),99);
  assert.equal(l.get('session'),null);
});
test('wizard requires confirmation; replayed Telegram update never duplicates purchase',t=>{
  const l=new Ledger();t.after(()=>l.close());
  ['/start secret-pairing','Купил','RTX 3060','15000','Сегодня'].forEach((s,i)=>update(l,i+1,s));
  assert.equal(l.all().length,0);
  update(l,6,'Подтвердить');
  update(l,6,'Подтвердить');
  assert.equal(l.all().length,1);
  assert.equal(l.all()[0].cost,1500000);
  assert.equal(l.get('offset'),7);
  assert.equal(l.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n,6);
});
test('invalid amount retains wizard step and user can cancel',t=>{
  const l=new Ledger();t.after(()=>l.close());
  ['/start secret-pairing','Купил','SSD','пять тысяч'].forEach((s,i)=>update(l,i+1,s));
  assert.equal(l.get('session').step,1);
  update(l,5,'Отмена');
  assert.equal(l.get('session'),null);
  assert.equal(l.all().length,0);
});
test('persistent wizard, owner, confirmed records and offset survive restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'perekup-test-'));
  const path=join(dir,'test.sqlite');
  let l=new Ledger(path);
  try {
    ['/start secret-pairing','Купил','SSD'].forEach((s,i)=>update(l,i+1,s));
    l.close();l=new Ledger(path);
    assert.equal(l.get('owner'),99);
    update(l,4,'2000');update(l,5,'Сегодня');update(l,6,'Подтвердить');
    l.close();l=new Ledger(path);
    assert.equal(l.all()[0].name,'SSD');assert.equal(l.get('offset'),7);
    update(l,6,'Подтвердить');assert.equal(l.all().length,1);
  } finally {l.close();rmSync(dir,{recursive:true,force:true});}
});
test('export does not include credentials, pairing or owner metadata',t=>{
  const l=new Ledger();t.after(()=>l.close());
  l.set('owner',999);l.set('secret','test');buy(l,'SSD',10000);
  const out=l.export();
  assert.equal(out.items.length,1);
  assert.equal(out.meta,undefined);
  assert.ok(!JSON.stringify(out).includes('secret'));
});
test('monthly report excludes other-month sales and purchases',t=>{
  const l=new Ledger();t.after(()=>l.close());
  l.buy({name:'Old',cost:10000,kind:'purchase',acquired:'2020-01-01'});
  l.sell({item:1,amount:15000,day:'2020-02-01'});
  assert.match(l.report('2020-01'),/Продано: 0/);
  assert.match(l.report('2020-02'),/Продано: 1/);
  assert.ok(l.report('2020-02').includes(`Результат по внесённым данным: ${rub(5000)}`));
});
