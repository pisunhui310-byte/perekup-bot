import { makeApi, ApiError } from './network.mjs';
const token=process.env.TELEGRAM_BOT_TOKEN?.trim();
delete process.env.TELEGRAM_BOT_TOKEN;
if(!token) { console.error('No stored Telegram token.'); process.exitCode=1; }
else {
  try {
    const api=makeApi(token);
    const me=await api('getMe',{});
    const hook=await api('getWebhookInfo',{});
    console.log(`Telegram connection OK. Token accepted. Bot: @${me.username}`);
    console.log(hook.url ? 'Existing webhook detected; use a dedicated bot.' : 'No webhook: ready for polling.');
  } catch(e) { console.error(e instanceof ApiError ? e.message : 'Connection check failed.'); process.exitCode=1; }
}
