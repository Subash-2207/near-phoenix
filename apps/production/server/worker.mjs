import { configureProvider, executeAgent, verifyModel } from './agents.mjs';
import { chainConfig, isFunded, readProjectTask, verifyProgram } from './solana.mjs';

export const now = () => Math.floor(Date.now() / 1000);
export const sql = (db, query, ...params) => db.prepare(query).bind(...params);

export async function sha256(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

const leaseSeconds = 90;
const maxAttempts = 3;
const serviceWindow = 240;

export async function workerReady(db, reference = now()) {
  const health = await sql(db,"SELECT verified_at FROM runtime_health WHERE name='runner'").first();
  return Boolean(health && health.verified_at > reference - serviceWindow);
}

async function verifyService(env, chain) { await Promise.all([verifyModel(env),verifyProgram(chain)]); }

async function finishProject(db) {
  const item = await sql(db, `SELECT id FROM projects p WHERE state='running'
    AND EXISTS (SELECT 1 FROM jobs WHERE project_id=p.id)
    AND NOT EXISTS (SELECT 1 FROM jobs WHERE project_id=p.id AND status!='completed')
    ORDER BY created_at LIMIT 1`).first();
  if (!item) return false;
  const { results } = await sql(db, 'SELECT role, output FROM jobs WHERE project_id=? ORDER BY position', item.id).all();
  const digest = await sha256(JSON.stringify(results.map(({ role, output }) => [role, JSON.parse(output)])));
  await sql(db, "UPDATE projects SET state='review', delivery_hash=? WHERE id=? AND state='running'", digest, item.id).run();
  return true;
}

export async function drainOne(env, execute = executeAgent, clock = now, observe = readProjectTask, probe = verifyService) {
  const chain = chainConfig(env);
  if (!env.DB || !configureProvider(env) || !chain) return { status: 'unavailable' };
  const db = env.DB;
  const started = clock();
  const health = await sql(db,"SELECT verified_at FROM runtime_health WHERE name='runner'").first();
  if (!health || health.verified_at <= started-120) {
    try { await probe(env,chain); }
    catch { return { status: 'unavailable' }; }
    await sql(db,`INSERT INTO runtime_health(name,verified_at) VALUES('runner',?)
      ON CONFLICT(name) DO UPDATE SET verified_at=MAX(verified_at,excluded.verified_at)`,started).run();
  }
  await sql(db, `UPDATE jobs SET status=CASE WHEN attempt>=? THEN 'failed' ELSE 'queued' END,
    error='Worker lease expired.', lease=NULL, lease_until=NULL, ready_at=?, updated_at=?
    WHERE status='running' AND lease_until<=?`, maxAttempts, started, started, started).run();
  if (await finishProject(db)) return { status: 'ready_for_review' };
  const lease = crypto.randomUUID();
  const claimed = await sql(db, `UPDATE jobs SET status='running', attempt=attempt+1, lease=?, lease_until=?, updated_at=?, error=NULL
    WHERE (project_id, position) = (SELECT j.project_id, j.position FROM jobs j JOIN projects p ON p.id=j.project_id
      WHERE j.status='queued' AND j.attempt<? AND j.ready_at<=? AND p.state='running'
      AND NOT EXISTS (SELECT 1 FROM jobs older WHERE older.project_id=j.project_id AND older.position<j.position AND older.status!='completed')
      ORDER BY p.created_at, j.position LIMIT 1)
      AND status='queued' RETURNING project_id, position, role, attempt`, lease, started+leaseSeconds, started, maxAttempts, started).first();
  if (!claimed) return { status: 'idle' };
  const id = claimed.project_id;
  try {
    const project = await sql(db, 'SELECT title, requirements, budget, task_seed, task, wallet FROM projects WHERE id=?', id).first();
    const observed = await observe(chain, project, project.task, project.wallet);
    if (!isFunded(observed.state, project.budget)) {
      await sql(db, `UPDATE jobs SET status='failed', error='The finalized escrow is no longer funded or is held.',
        lease=NULL, lease_until=NULL, updated_at=? WHERE project_id=? AND position=? AND lease=? AND lease_until>?`,
      clock(), id, claimed.position, lease, clock()).run();
      return { status: 'escrow_held' };
    }
    const previous = await sql(db, "SELECT role, output FROM jobs WHERE project_id=? AND status='completed' ORDER BY position", id).all();
    const output = await execute(env, claimed.role, project, previous.results);
    const stored = await sql(db, `UPDATE jobs SET status='completed', output=?, lease=NULL, lease_until=NULL, updated_at=?
      WHERE project_id=? AND position=? AND status='running' AND lease=? AND lease_until>?
      AND EXISTS (SELECT 1 FROM projects WHERE id=? AND state='running') RETURNING role`,
    JSON.stringify(output), clock(), id, claimed.position, lease, clock(), id).first();
    if (!stored) return { status: 'lease_lost' };
    await finishProject(db);
    return { status: 'completed', role: claimed.role };
  } catch (error) {
    console.error('PHOENIX worker failure:', claimed.role, error instanceof Error ? error.message : 'Unknown error');
    const completedAt = clock();
    const next = claimed.attempt >= maxAttempts ? 'failed' : 'queued';
    const updated = await sql(db, `UPDATE jobs SET status=?, error='The agent attempt did not complete.', lease=NULL, lease_until=NULL,
      ready_at=?, updated_at=? WHERE project_id=? AND position=? AND status='running' AND lease=? AND lease_until>? RETURNING role`,
    next, completedAt + 15 * 2 ** (claimed.attempt - 1), completedAt, id, claimed.position, lease, completedAt).first();
    return { status: updated ? next : 'lease_lost', role: claimed.role };
  }
}
