CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  customer TEXT NOT NULL,
  title TEXT NOT NULL,
  requirements TEXT NOT NULL,
  budget TEXT NOT NULL,
  task_seed TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('awaiting_funding','running','review','held','approved','settled')),
  task TEXT UNIQUE,
  wallet TEXT,
  delivery_hash TEXT,
  approved_at INTEGER,
  observed_slot INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX projects_customer ON projects(customer, created_at);

CREATE TABLE jobs (
  project_id TEXT NOT NULL REFERENCES projects(id),
  position INTEGER NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  ready_at INTEGER NOT NULL DEFAULT 0,
  lease TEXT,
  lease_until INTEGER,
  output TEXT,
  error TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, position)
);
CREATE INDEX jobs_availability ON jobs(status, ready_at, lease_until, project_id, position);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  role TEXT,
  attempt INTEGER,
  happened_at INTEGER NOT NULL
);
CREATE INDEX events_project ON events(project_id, id);

CREATE TABLE runtime_health (
  name TEXT PRIMARY KEY,
  verified_at INTEGER NOT NULL
);

CREATE TRIGGER project_created AFTER INSERT ON projects BEGIN
  INSERT INTO events(project_id, kind, happened_at) VALUES (NEW.id, 'project_submitted', NEW.created_at);
END;

CREATE TRIGGER project_changed AFTER UPDATE OF state ON projects WHEN NEW.state <> OLD.state BEGIN
  INSERT INTO events(project_id, kind, happened_at) VALUES (NEW.id, NEW.state, unixepoch());
END;

CREATE TRIGGER job_changed AFTER UPDATE OF status ON jobs WHEN NEW.status <> OLD.status BEGIN
  INSERT INTO events(project_id, kind, role, attempt, happened_at) VALUES
    (NEW.project_id, CASE
      WHEN NEW.status = 'running' AND NEW.attempt > 1 THEN 'backup_started'
      WHEN NEW.status = 'running' THEN 'agent_started'
      WHEN NEW.status = 'completed' THEN 'artifact_committed'
      WHEN NEW.status = 'queued' THEN 'retry_scheduled'
      ELSE 'agent_failed' END, NEW.role, NEW.attempt, NEW.updated_at);
  UPDATE projects SET state = 'held' WHERE id = NEW.project_id AND state = 'running' AND NEW.status = 'failed';
END;
