import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger,today,rub } from '../ledger.mjs';
import { reply } from '../conversation.mjs';
import { inlineMarkup } from '../telegram-ui.mjs';

function setup(t) {
  const l=new Ledger();t.after(()=>l.close());
  l.buy({name:'RTX 4060',kind:'purchase',cost:0,acquired:today()});
  l.db.prepare('UPDATE items SET listing_price=3500000 WHERE id=1').run();
  return l;
}
test('stock card exposes delivery; confirmation records expected payout without revenue',t=>{
  const l=setup(t);
  const card=reply(l,'Товар #1 · RTX 4060');
  assert.ok(card.keyboard.flat().includes('В доставке #1'));
  assert.ok(!card.text.includes('Себестоимость'));
  const markup=inlineMarkup(l,{id:1,chat:99},card);
  assert.equal(markup.inline_keyboard[0][0].text,'🚚 Едет к покупателю');
  reply(l,'В доставке #1');
  const preview=reply(l,'32835');
  assert.ok(preview.text.includes(rub(3283500)));
  assert.equal(l.item(1).fulfillment,'listed');
  reply(l,'Подтвердить');
  assert.equal(l.item(1).fulfillment,'in_transit');
  assert.equal(l.item(1).sold_on,null);
  assert.equal(l.stockTotals().transit,3283500);
  const transitCard=reply(l,'Товар #1 · RTX 4060');
  assert.ok(transitCard.keyboard.flat().includes('Покупатель забрал #1'));
  assert.ok(transitCard.keyboard.flat().includes('Возврат #1'));
  reply(l,'Покупатель забрал #1');reply(l,'Подтвердить');
  assert.equal(l.item(1).sale,3283500);
  assert.equal(l.stockItems().length,0);
});
test('cancel does not send item; return does not record sale',t=>{
  const l=setup(t);
  reply(l,'В доставке #1');reply(l,'1234');reply(l,'Отмена');
  assert.equal(l.item(1).fulfillment,'listed');
  reply(l,'В доставке #1');reply(l,'1234');reply(l,'Подтвердить');
  reply(l,'Возврат #1');reply(l,'Подтвердить');
  assert.equal(l.item(1).fulfillment,'listed');
  assert.equal(l.item(1).sale,null);
  assert.equal(l.stockTotals().transit,0);
});
