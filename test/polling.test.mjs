import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../network.mjs';
import { PollHealth, pollUpdates } from '../polling.mjs';

test('polling waits through a transient Telegram 409', async()=>{
  let calls=0, now=0; const health=new PollHealth(()=>now,1000);
  health.authenticated();
  const result=await pollUpdates(async()=>{ calls++; if(calls<3) throw new ApiError(409); return [{update_id:1}]; },{},health,{now:()=>now,sleep:async()=>{now+=100;},warn:()=>{},retryMs:10});
  assert.deepEqual(result,[{update_id:1}]); assert.equal(calls,3); assert.equal(health.status().code,200);
});

test('persistent Telegram 409 eventually fails and marks health degraded', async()=>{
  let now=0; const health=new PollHealth(()=>now,1000); health.authenticated();
  await assert.rejects(pollUpdates(async()=>{throw new ApiError(409);},{},health,{now:()=>now,sleep:async()=>{now+=100;},warn:()=>{},conflictTimeoutMs:250,retryMs:100}),e=>e.code===409);
  assert.equal(health.status().code,200); // auth grace is still alive while the old instance hands over
  health.stop(); assert.equal(health.status().code,503);
});
