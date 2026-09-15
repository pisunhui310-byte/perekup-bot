import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApi, networkReason, ApiError } from '../network.mjs';

test('network diagnostics identify proxy, DNS and timeout failures without leaking URLs',()=>{
  assert.match(networkReason({cause:{code:'ECONNREFUSED'}}),/прокси/);
  assert.match(networkReason({cause:{errors:[{code:'ENOTFOUND'}]}}),/DNS/);
  assert.match(networkReason({name:'TimeoutError'}),/время/);
  assert.match(networkReason({cause:{code:'UNABLE_TO_VERIFY_LEAF_SIGNATURE'}}),/сертификата/);
  assert.ok(!networkReason(new Error('https://api.telegram.org/botSECRET')).includes('SECRET'));
});
test('API returns successful results and serializes request correctly',async()=>{
  const api=makeApi('test-token',async(url,options)=>{
    assert.equal(url,'https://api.telegram.org/bottest-token/getMe');
    assert.equal(options.method,'POST');
    assert.equal(options.body,'{}');
    return {json:async()=>({ok:true,result:{id:1}})};
  });
  assert.deepEqual(await api('getMe',{}),{id:1});
});
test('API distinguishes invalid credentials and rate limiting from network failures',async()=>{
  for(const code of [401,429]) {
    const api=makeApi('test-token',async()=>({json:async()=>({ok:false,error_code:code,parameters:{retry_after:8}})}));
    await assert.rejects(api('getMe',{}),e=>e instanceof ApiError && e.code===code && e.delay===8);
  }
});
test('transport errors never print token-bearing errors or nested stacks',async()=>{
  const api=makeApi('SECRET',async()=>{throw new Error('https://api.telegram.org/botSECRET/getMe',{cause:{code:'ECONNRESET'}});});
  await assert.rejects(api('getMe',{}),e=>e instanceof ApiError && !e.stack.includes('SECRET') && e.message.includes('оборвалось'));
});
