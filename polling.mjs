import { ApiError } from './network.mjs';

// Render keeps the old instance alive during the deployment handover.
// Permit that bounded handover, but never leave a dead poller healthy forever.
export class PollHealth {
  constructor(now=Date.now, graceMs=120000) {
    this.now=now; this.graceMs=graceMs; this.lastActivity=null; this.stopped=false;
    this.state='starting';
  }
  authenticated() { this.lastActivity=this.now(); this.state='waiting_for_updates'; }
  received() { this.lastActivity=this.now(); this.state='polling'; }
  conflict() { this.state='conflict'; }
  stop() { this.stopped=true; this.state='stopped'; }
  status() {
    const healthy=!this.stopped && this.lastActivity!==null && this.now()-this.lastActivity<this.graceMs;
    return {code:healthy?200:503,state:this.state};
  }
}

export async function pollUpdates(api, payload, health, {
  now=Date.now, sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)), warn=console.error,
  conflictTimeoutMs=120000, retryMs=10000
}={}) {
  const started=now(); let warned=false;
  for (;;) {
    try {
      const result=await api('getUpdates',payload);
      health.received();
      if(warned) warn('Конфликт Telegram устранён. Получение сообщений восстановлено.');
      return result;
    } catch(e) {
      if(!(e instanceof ApiError) || e.code!==409) throw e;
      health.conflict();
      if(!warned) { warn('Telegram 409: другой процесс получает сообщения. Жду завершения старого экземпляра до 120 секунд.'); warned=true; }
      const remaining=conflictTimeoutMs-(now()-started);
      if(remaining<=0) throw e;
      await sleep(Math.min(retryMs,remaining));
    }
  }
}
