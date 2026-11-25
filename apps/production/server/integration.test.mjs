import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createHandler } from './index.mjs';
import { drainOne, now } from './worker.mjs';
import { executeAgent, team, validateFiles } from './agents.mjs';

function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../migrations/0001.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) { return { bind(...values) {
      const statement = sqlite.prepare(sql);
      return {
        async first() { return statement.get(...values) ?? null; },
        async all() { return { results: statement.all(...values) }; },
        async run() { return statement.run(...values); },
      };
    } }; },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
}

function environment(db) {
  return { DB: db, OPENAI_API_KEY: 'fixture', PHOENIX_MODEL: 'fixture', PHOENIX_PUBLIC_ORIGIN:'https://phoenix.test',
    PHOENIX_PROGRAM_ID: 'So11111111111111111111111111111111111111112',
    PHOENIX_OPERATOR: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', PHOENIX_BACKUP: 'ComputeBudget111111111111111111111111111111',
    PHOENIX_SENTINEL: 'AddressLookupTab1e1111111111111111111111111', PHOENIX_GUARDIAN: 'Vote111111111111111111111111111111111111111',
    PHOENIX_WORKER_TOKEN: 'fixture_only_not_a_deployment_secret_01',
  };
}

const fundedState = { phase:'Running', escrowRemaining:'1250000000', escrowPaid:'0', escrowRefunded:'0', paymentNonce:'0' };

test('customer intake, ownership, escrow, all agents, approval and settlement use durable records', async t => {
  const db = database(t), env = environment(db);
  let observed = { slot:1000, state: { ...fundedState, escrowRemaining:'1' } };
  const observe = async () => observed;
  const handler = createHandler({ observe });
  const id = crypto.randomUUID();
  const origin = 'https://phoenix.test';
  const call = (path, payload, id='customer-a', source=origin) => handler(new Request(origin+'/api/production'+path, {
    method: payload ? 'POST' : 'GET', headers: { 'content-type':'application/json', origin:source,
      ...(id && { 'oai-authenticated-user-id':id, 'oai-authenticated-user-email':id+'@example.test' }) },
    ...(payload && {body: JSON.stringify(payload)}),
  }), env);
  const payload = { id, title:'Local bookstore website', requirements:'Build an accessible catalog and explain how to publish the source.', budgetSol:'1.25' };
  assert.equal((await call('/projects',null,null)).status,401);
  assert.equal((await call('/worker',{})).status,401);
  assert.equal((await call('/projects',payload,'customer-a','https://other.test')).status,403);
  const first = await call('/projects',payload);
  assert.equal(first.status,201);
  assert.equal((await first.json()).project.budget,fundedState.escrowRemaining);
  assert.equal((await call('/projects',payload)).status,201);
  assert.equal((await call('/projects/'+id,null,'customer-b')).status,404);
  assert.equal((await call('/projects/'+id+'/funding',{task:'task',wallet:'wallet'})).status,503);
  assert.equal((await drainOne(env,undefined,now,observe,async()=>{})).status,'idle');
  assert.equal((await call('/projects/'+id+'/funding',{task:'task',wallet:'wallet'})).status,409);
  observed = { slot:1000, state:fundedState };
  assert.equal((await call('/projects/'+id+'/funding',{task:'task',wallet:'wallet'})).status,200);
  assert.equal((await call('/projects/'+id+'/settlement',{})).status,409);
  const artifact = (role, output=role) => ({ file:role+'.md', content:output, sources:[] });
  let tick=now(), release;
  const stale = drainOne(env, async (_env,role)=> {
    await new Promise(resolve => {release=resolve;});
    return artifact(role, 'discard stale result');
  }, () => tick, observe, async()=>{});
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await drainOne(env, async ()=>assert.fail('cannot double-claim'), () => tick, observe, async()=>{})).status, 'idle');
  tick+=91;
  assert.equal((await drainOne(env, async (_env,role)=>artifact(role), () => tick, observe, async()=>{})).role,'manager');
  release();
  assert.equal((await stale).status,'lease_lost');
  for (const [index, {id:role}] of team.entries()) {
    if (index===0) continue;
    const result = await drainOne(env, async (_env,actual,project,previous)=> {
      assert.equal(actual,role);
      assert.equal(project.title,payload.title);
      assert.equal(previous.length,index);
      assert.equal(JSON.parse(previous[0].output).content,'manager');
      return artifact(role);
    }, () => ++tick, observe, async()=>{});
    assert.equal(result.status,'completed');
  }
  const review = await (await call('/projects/'+id)).json();
  assert.equal(review.project.state,'review');
  assert.equal(review.jobs.length,7);
  assert.ok(review.events.some(event => event.kind==='backup_started'&&event.role==='manager'));
  assert.match(review.project.delivery_hash,/^[a-f0-9]{64}$/);
  assert.equal((await call('/projects/'+id+'/approve',{digest:'other'})).status,409);
  assert.equal((await call('/projects/'+id+'/approve',{digest:review.project.delivery_hash})).status,200);
  observed={slot:1001,state:{ ...fundedState,escrowRemaining:'0',escrowPaid:fundedState.escrowRemaining,paymentNonce:'1',checkpointHash:'unapproved' }};
  assert.equal((await call('/projects/'+id+'/settlement',{})).status,409);
  observed.state.checkpointHash=review.project.delivery_hash;
  assert.equal((await call('/projects/'+id+'/settlement',{})).status,200);
  assert.equal((await (await call('/projects/'+id)).json()).project.state,'settled');
});

test('agent output is bounded and research preserves fetched source annotations', async () => {
  assert.throws(() => validateFiles(JSON.stringify({ files:[{path:'../secret',content:'no'}], limitations:'' })), /unsafe/);
  assert.throws(() => validateFiles(JSON.stringify({ files:[{path:'APP.ts',content:''},{path:'app.ts',content:''}], limitations:'' })), /duplicate/);
  const artifact = await executeAgent(environment(null), 'research', { title:'Test',requirements:'Research',budget:'1' }, [], async (url, init) => {
    assert.equal(url,'https://api.openai.com/v1/responses');
    const request=JSON.parse(init.body);
    assert.equal(request.store,false);
    assert.equal(request.tools[0].type,'web_search');
    return Response.json({id:'resp_fixture',status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Research result',annotations:[{type:'url_citation',url:'https://example.test/source',title:'Source'}]}]}]});
  });
  assert.equal(artifact.sources[0].url,'https://example.test/source');
  assert.equal(artifact.content,'Research result');
});
