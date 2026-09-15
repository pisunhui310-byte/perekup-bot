import { ApiError } from './network.mjs';
export class AvitoClient {
  constructor(id, secret) { this.id=id; this.secret=secret; this.token=null; this.expires=0; }
  async api(path, options={}) {
    if(!this.token || Date.now()>this.expires) {
      const b=Buffer.from(this.id+':'+this.secret).toString('base64');
      const r=await fetch('https://api.avito.ru/token',{method:'POST',headers:{Authorization:'Basic '+b,'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials',signal:AbortSignal.timeout(30000)});
      const j=await r.json(); if(!r.ok) throw new ApiError(`Avito token ${r.status}`); this.token=j.access_token; this.expires=Date.now()+(j.expires_in-60)*1000;
    }
    const r=await fetch('https://api.avito.ru'+path,{...options,headers:{...(options.headers||{}),Authorization:'Bearer '+this.token},signal:AbortSignal.timeout(30000)});
    if(!r.ok) throw new ApiError(`Avito ${r.status}`); return r.json();
  }
  async items() {
    const result=new Map();
    for(let page=1;page<=1000;page++) {
      const response=await this.api(`/core/v1/items?page=${page}&per_page=25`);
      if(!Array.isArray(response.resources)) throw new ApiError('Avito: неверный ответ списка объявлений');
      const rows=response.resources;
      const previous=result.size;
      for(const item of rows) result.set(item.id,item);
      if(rows.length<25) return [...result.values()];
      if(result.size===previous) throw new ApiError('Avito: повтор страницы объявлений');
    }
    throw new ApiError('Avito: превышен размер списка объявлений');
  }
  async itemStatus(itemId) {
    if(!this.accountId) this.accountId=(await this.api('/core/v1/accounts/self')).id;
    return this.api(`/core/v1/accounts/${this.accountId}/items/${itemId}/`);
  }
  async checkDeliveryAccess() {
    try {
      await this.api('/order-management/1/orders?limit=1&page=1');
      return 'available_unconfigured';
    } catch(e) {
      if(e.code==='Avito 403') return 'forbidden';
      throw e;
    }
  }
  async account() { return this.api('/core/v1/accounts/self'); }
  async stats(accountId,itemIds) {
    const to=new Date(), from=new Date(Date.now()-30*86400000);
    const body={itemIds,dateFrom:from.toISOString().slice(0,10),dateTo:to.toISOString().slice(0,10),fields:['views','contacts','favorites','orders','spend']};
    return this.api(`/stats/v2/accounts/${accountId}/items`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  }
}
