import { randomBytes } from 'node:crypto';
import { mkdirSync, existsSync, openSync, closeSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup } from 'node:sqlite';
import { createServer } from 'node:http';
import { Ledger } from './ledger.mjs';
import { processUpdate } from './conversation.mjs';
import { ApiError, makeApi } from './network.mjs';
import { AvitoClient } from './avito.mjs';
import { deliver } from './telegram-ui.mjs';
import { runAvitoSync } from './avito-sync.mjs';
import { PollHealth, pollUpdates } from './polling.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const dir=join(root,'data');
mkdirSync(dir,{recursive:true});
const token=process.env.TELEGRAM_BOT_TOKEN?.trim();
if(!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
  console.error('Нет токена Telegram. Запусти start.cmd и введи токен от BotFather.');
  process.exit(1);
}
delete process.env.TELEGRAM_BOT_TOKEN;
const lock=join(dir,'bot.lock');
if(existsSync(lock)) {
  let alive=true;
  try { const pid=Number(readFileSync(lock,'utf8')); if(!Number.isInteger(pid)||pid<=0) throw new Error(); process.kill(pid,0); }
  catch(e) { if(e.code==='EPERM') alive=true; else alive=false; }
  if(alive) { console.error('Бот уже запущен. Закрой его старое окно перед новым запуском.'); process.exit(1); }
  unlinkSync(lock);
}
try { const fd=openSync(lock,'wx'); writeFileSync(fd,String(process.pid)); closeSync(fd); }
catch { console.error('Не удалось получить блокировку запуска.'); process.exit(1); }
process.on('exit',()=>{try{unlinkSync(lock);}catch{}});

const ledger=new Ledger(join(dir,'accounting.sqlite'));
const health=new PollHealth();
let webhookHandler=null;
const healthServer=createServer(async (req,res)=>{
  if(req.url==='/health'){const status=health.status();res.writeHead(status.code,{'content-type':'text/plain'});res.end(status.state);return;}
  if(req.url==='/telegram' && req.method==='POST' && webhookHandler) {
    let body=''; for await (const chunk of req) body+=chunk;
    try { await webhookHandler(JSON.parse(body)); res.writeHead(200); res.end('ok'); }
    catch { res.writeHead(500); res.end('error'); }
    return;
  }
  res.writeHead(404);res.end();
});
healthServer.listen(Number(process.env.PORT||10000),'0.0.0.0');
let closed=false;
function shutdown() {
  if(closed) return;
  closed=true; health.stop(); healthServer.close(); healthServer.closeAllConnections(); ledger.close();
}
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{shutdown();process.exit(0);});
// Remove obsolete delivery-access warnings queued by older bot versions.
ledger.db.prepare("DELETE FROM outbox WHERE payload LIKE '%Доставки: Avito API вернул 403%'").run();
const avito=(process.env.AVITO_CLIENT_ID&&process.env.AVITO_CLIENT_SECRET)?new AvitoClient(process.env.AVITO_CLIENT_ID,process.env.AVITO_CLIENT_SECRET):null;
mkdirSync(join(dir,'backups'),{recursive:true});
await backup(ledger.db,join(dir,'backups',`${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`));
const code=randomBytes(16).toString('hex');
const api=makeApi(token);
async function flush() {
  for(const row of ledger.db.prepare('SELECT * FROM outbox ORDER BY id').all()) {
    await deliver(ledger,row,api);
  }
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  const me=await api('getMe',{});
  const hook=await api('getWebhookInfo',{});
  if(hook.url) {
    console.error('У этого бота уже есть webhook другой программы. Создай отдельного бота в BotFather.');
    process.exitCode=1;
  } else {
    health.authenticated();
    console.log(`Telegram принял токен @${me.username}. Подключаю получение сообщений…`);
    if(!ledger.get('owner')) console.log(`Для личной привязки открой ссылку и нажми Start:\nhttps://t.me/${me.username}?start=${code}\nНикому не пересылай эту ссылку.`);
    else console.log(`Открой https://t.me/${me.username} — доступ разрешён только привязанному владельцу.`);
    console.log('Остановить: Ctrl+C.');
    let delay=1000;
    let announced=false;
    const renderUrl=(process.env.RENDER_EXTERNAL_URL||'').replace(/\/$/,'');
    if(renderUrl) {
      webhookHandler=async update=>{ const answer=processUpdate(ledger,update,code); if(update.callback_query) { try { await api('answerCallbackQuery',{callback_query_id:update.callback_query.id,text:answer?.callbackText||''}); } catch {} } await flush(); health.received(); };
      await api('setWebhook',{url:`${renderUrl}/telegram`,drop_pending_updates:false});
      console.log(`Webhook Telegram подключён: ${renderUrl}/telegram`);
      for (;;) { await runAvitoSync(ledger,avito); await flush(); await sleep(30000); }
    }
    while(true) {
      try {
        await runAvitoSync(ledger,avito);
        await flush();
        const updates=await pollUpdates(api,{offset:ledger.get('offset',0),timeout:25,allowed_updates:['message','callback_query']},health);
        if(!announced) { console.log(`Бот @${me.username} принимает сообщения.`); announced=true; }
        for(const update of updates) {
          const answer=processUpdate(ledger,update,code);
          if(update.callback_query) {
            try { await api('answerCallbackQuery',{callback_query_id:update.callback_query.id,text:answer?.callbackText || ''}); }
            catch(e) { if(!(e instanceof ApiError)) throw e; /* Expired callback acknowledgments never block accounting. */ }
          }
          await flush();
          if(ledger.get('avito_refresh_requested')) { await runAvitoSync(ledger,avito); await flush(); }
        }
        delay=1000;
      } catch(e) {
        if(!(e instanceof ApiError)) { console.error('Ошибка обработки данных. Остановлено; база сохранена. Проверь код и резервную копию.'); process.exitCode=1; break; }
        if(e.code===409) { console.error('Telegram 409 не исчез за 120 секунд. Останови вторую копию этого бота на компьютере или хостинге. Процесс завершается.'); process.exitCode=1; break; }
        if([401,403].includes(e.code)) { console.error(`${e.message}. Проверь токен и доступ бота.`); process.exitCode=1; break; }
        console.error(`${e.message}. Повтор подключения…`);
        await sleep(Math.max(delay,Math.min(e.delay*1000,60000))); delay=Math.min(delay*2,30000);
      }
    }
  }
} catch(e) {
  console.error(e instanceof ApiError ? `${e.message}.${e.code===401 ? ' Токен не принят: запусти replace-token.cmd.' : ' После исправления повтори запуск start.cmd.'}` : 'Не удалось запустить бота.');
  process.exitCode=1;
} finally { shutdown(); }
