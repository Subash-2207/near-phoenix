import { configureProvider, team } from './agents.mjs';
import { chainConfig, isFunded, isSettled, readProjectTask } from './solana.mjs';
import { drainOne, now, sha256, sql, workerReady } from './worker.mjs';

const api = '/api/production';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const maxBody = 24000;
const maxU64 = 18446744073709551615n;
const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const fail = (error, status) => json({ error }, status);

function customer(request, env) {
  if (!env.PHOENIX_PUBLIC_ORIGIN || new URL(request.url).origin !== env.PHOENIX_PUBLIC_ORIGIN) return null;
  const id = request.headers.get('oai-authenticated-user-id');
  return id && id.length <= 180 && request.headers.has('oai-authenticated-user-email') ? id : null;
}

async function input(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new Error('Send a JSON request.');
  if (!request.body) throw new Error('Send a JSON request body.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBody) throw new Error('The project submission exceeds the allowed size.');
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    const payload = JSON.parse(body);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Send a JSON object.');
    return payload;
  } finally {
    await reader.cancel();
  }
}

function lamports(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,10})(?:\.[0-9]{1,9})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0'));
  return amount > 0n && amount <= maxU64 ? amount.toString() : null;
}

async function sameToken(request, token) {
  if (!token || typeof token !== 'string' || token.length < 32) return false;
  const supplied = request.headers.get('authorization');
  if (!supplied?.startsWith('Bearer ') || supplied.length > 300) return false;
  const hashes = await Promise.all([sha256(supplied.slice(7)), sha256(token)]);
  let difference = 0;
  for (let i=0; i<hashes[0].length; i++) difference |= hashes[0].charCodeAt(i) ^ hashes[1].charCodeAt(i);
  return difference === 0;
}

function publicProject({ customer: _, ...project }) { return project; }

async function projectDetails(db, project) {
  const [jobs, events] = await Promise.all([
    sql(db, 'SELECT role, status, attempt, output, error, updated_at FROM jobs WHERE project_id=? ORDER BY position', project.id).all(),
    sql(db, 'SELECT id, kind, role, attempt, happened_at FROM events WHERE project_id=? ORDER BY id DESC LIMIT 100', project.id).all(),
  ]);
  return {
    project: publicProject(project),
    jobs: jobs.results.map(({ output, ...job }) => ({ ...job, output: output ? JSON.parse(output) : null })),
    events: events.results.reverse(),
  };
}

async function createProject(db, owner, request) {
  const { id, title, requirements, budgetSol } = await input(request);
  const name = typeof title === 'string' ? title.trim() : '';
  const brief = typeof requirements === 'string' ? requirements.trim() : '';
  const budget = lamports(budgetSol);
  if (!uuid.test(id) || name.length < 3 || name.length > 120 || brief.length < 20 || brief.length > 12000 || !budget) {
    return fail('Enter a project title, requirements between 20 and 12,000 characters, and a positive SOL budget.', 422);
  }
  const seed = await sha256('PHOENIX project v1:' + id);
  await db.batch([
    sql(db, `INSERT INTO projects(id,customer,title,requirements,budget,task_seed,state,created_at)
      VALUES(?,?,?,?,?,?,'awaiting_funding',?) ON CONFLICT(id) DO NOTHING`, id, owner, name, brief, budget, seed, now()),
    ...team.map(({ id: role }, i) => sql(db, `INSERT INTO jobs(project_id, position, role)
      SELECT id, ?, ? FROM projects WHERE id=? AND customer=? ON CONFLICT DO NOTHING`, i, role, id, owner)),
  ]);
  const project = await sql(db, 'SELECT * FROM projects WHERE id=? AND customer=?', id, owner).first();
  return project ? json(await projectDetails(db, project), 201) : fail('The project could not be created.', 409);
}

async function transition(db, project, action, request, env, observe) {
  const chain = chainConfig(env);
  if (!chain || (action === 'funding' && (!configureProvider(env) || !(await workerReady(db))))) {
    return fail('The live project service is awaiting deployment configuration or worker verification.', 503);
  }
  if (action === 'funding' && project.state === 'awaiting_funding') {
    const { task, wallet } = await input(request);
    const observed = await observe(chain, project, task, wallet);
    if (!isFunded(observed.state, project.budget)) return fail('The finalized task must hold the exact project budget with no recorded payouts or refunds.', 409);
    const result = await sql(db, `UPDATE projects SET state='running', task=?, wallet=?, observed_slot=?
      WHERE id=? AND state='awaiting_funding' RETURNING id`, task, wallet, observed.slot, project.id).first();
    return result ? json({ state: 'running' }) : fail('This project changed. Refresh the page and try again.', 409);
  }
  if (action === 'approve' && project.state === 'review') {
    const { digest } = await input(request);
    if (digest !== project.delivery_hash) return fail('Review the current delivery before approving it.', 409);
    const observed = await observe(chain, project, project.task, project.wallet);
    if (!isFunded(observed.state, project.budget)) return fail('The delivery cannot be approved while the finalized escrow is held or has changed.', 409);
    const result = await sql(db, `UPDATE projects SET state='approved', approved_at=?, observed_slot=?
      WHERE id=? AND state='review' AND delivery_hash=? RETURNING id`, now(), observed.slot, project.id, digest).first();
    return result ? json({ state: 'approved' }) : fail('This project changed. Refresh and review it again.', 409);
  }
  if (action === 'settlement' && project.state === 'approved') {
    const observed = await observe(chain, project, project.task, project.wallet);
    if (observed.slot <= project.observed_slot || !isSettled(observed.state, project)) {
      return fail('The approved delivery digest and matching payout have not finalized on Solana.', 409);
    }
    const result = await sql(db, `UPDATE projects SET state='settled', observed_slot=?
      WHERE id=? AND state='approved' RETURNING id`, observed.slot, project.id).first();
    return result ? json({ state: 'settled' }) : fail('This project changed. Refresh the page and try again.', 409);
  }
  return fail('This action is unavailable in the current project state.', 409);
}

export function createHandler({ observe = readProjectTask, run = drainOne } = {}) {
  return async function handle(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== api && !url.pathname.startsWith(api + '/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : fail('Page not available.', 404);
    }
    const route = url.pathname.slice(api.length).replace(/\/$/, '');
    try {
      if (route === '/health' && request.method === 'GET') {
        const database = env.DB ? Boolean(await sql(env.DB, 'SELECT 1 AS ready FROM sqlite_master WHERE name=\'projects\'').first()) : false;
        return json({ database, agents: configureProvider(env), escrow: Boolean(chainConfig(env)), worker: database && await workerReady(env.DB) });
      }
      if (route === '/worker' && request.method === 'POST') {
        if (!(await sameToken(request, env.PHOENIX_WORKER_TOKEN))) return fail('Unauthorized.', 401);
        const result = await run(env);
        return json(result, result.status === 'unavailable' ? 503 : 200);
      }
      const owner = customer(request, env);
      if (!owner) return fail('Sign in to access your projects.', 401);
      const db = env.DB;
      if (!db) return fail('Project storage is unavailable.', 503);
      if (request.method === 'POST' && request.headers.get('origin') !== env.PHOENIX_PUBLIC_ORIGIN) {
        return fail('This request must come from the PHOENIX workspace.', 403);
      }
      if (route === '/projects' && request.method === 'GET') {
        const { results } = await sql(db, `SELECT id,title,budget,state,created_at FROM projects WHERE customer=?
          ORDER BY created_at DESC,id LIMIT 100`, owner).all();
        return json({ projects: results, chain: chainConfig(env), agentsConfigured: configureProvider(env) && await workerReady(db) });
      }
      if (route === '/projects' && request.method === 'POST') return await createProject(db, owner, request);
      const match = route.match(/^\/projects\/([^/]+)(?:\/(funding|approve|settlement))?$/);
      if (!match || !uuid.test(match[1])) return fail('Project not found.', 404);
      const project = await sql(db, 'SELECT * FROM projects WHERE id=? AND customer=?', match[1], owner).first();
      if (!project) return fail('Project not found.', 404);
      if (!match[2] && request.method === 'GET') return json(await projectDetails(db, project));
      if (match[2] && request.method === 'POST') return await transition(db, project, match[2], request, env, observe);
      return fail('Method not allowed.', 405);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (error instanceof SyntaxError || /JSON request|exceeds the allowed size|public task|finalized PHOENIX task|does not match this project/i.test(message)) {
        return fail(error instanceof SyntaxError ? 'The request body is invalid.' : message, 422);
      }
      console.error('PHOENIX API:', error instanceof Error ? error.name : 'Unknown error');
      return fail('The project service could not complete the request. Try again shortly.', 503);
    }
  };
}

export default {
  fetch: createHandler(),
  scheduled(_event, env, ctx) { ctx.waitUntil(drainOne(env)); },
};
