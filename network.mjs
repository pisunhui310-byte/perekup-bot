export class ApiError extends Error {
  constructor(code, delay=5) { super(`Telegram API: ${code}`); this.code=code; this.delay=delay; }
}
export function networkReason(error) {
  const codes=[error?.code,error?.cause?.code,...(error?.cause?.errors || []).map(e=>e.code)];
  if(error?.name==='TimeoutError' || codes.some(c=>['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT'].includes(c)))
    return 'истекло время подключения. Проверь, включён ли VPN/прокси и доступен ли Telegram';
  if(codes.includes('ECONNREFUSED')) return 'подключение отклонено. Если используется прокси, проверь, запущена ли его программа';
  if(codes.some(c=>['ENOTFOUND','EAI_AGAIN'].includes(c))) return 'ошибка DNS: не удалось найти сервер Telegram или прокси';
  if(codes.some(c=>['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(c)))
    return 'ошибка проверки сертификата. Нужна проверка даты компьютера и настроек VPN/антивируса';
  if(codes.some(c=>['ECONNRESET','EPIPE','UND_ERR_SOCKET'].includes(c))) return 'соединение оборвалось. Проверь VPN/прокси и повтори запуск';
  return 'сетевая ошибка. Проверь VPN/прокси и доступ к api.telegram.org';
}

export function makeApi(token, fetchImpl=fetch) {
  return async (method, payload, form=false) => {
    let response;
    try {
      response=await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method:'POST', headers:form?undefined:{'Content-Type':'application/json'},
        body:form?payload:JSON.stringify(payload), signal:AbortSignal.timeout(45000)
      });
    } catch(e) { throw new ApiError(networkReason(e)); }
    let r;
    try { r=await response.json(); } catch { throw new ApiError(response.status); }
    if(!r.ok) throw new ApiError(r.error_code,r.parameters?.retry_after || 5);
    return r.result;
  };
}
