/** Phase 9 trading ledger. Statements are additive. They never drop or delete. */
export const TRADING_STORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  environment TEXT NOT NULL,
  partition_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_requests (
  execution_request_id TEXT PRIMARY KEY,
  execution_identity TEXT NOT NULL UNIQUE,
  agent_run_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_attempts (
  execution_attempt_id TEXT PRIMARY KEY,
  execution_request_id TEXT NOT NULL,
  execution_identity TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  state TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  response_at TEXT,
  client_id TEXT NOT NULL,
  broker_request_id TEXT,
  broker_code TEXT,
  agent_run_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (execution_identity, sequence)
);
CREATE INDEX IF NOT EXISTS execution_attempts_identity
  ON execution_attempts(execution_identity, sequence);
CREATE TABLE IF NOT EXISTS trading_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  agent_run_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS broker_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  binding_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  provider TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  complete INTEGER NOT NULL,
  unavailable INTEGER NOT NULL,
  broker_call_skipped INTEGER NOT NULL,
  invalid INTEGER NOT NULL,
  orders_channel TEXT NOT NULL,
  deals_channel TEXT NOT NULL,
  positions_channel TEXT NOT NULL,
  account_channel TEXT NOT NULL,
  source TEXT NOT NULL,
  balance TEXT,
  equity TEXT,
  margin TEXT,
  currency TEXT,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS broker_orders (
  snapshot_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  client_id TEXT,
  symbol TEXT NOT NULL,
  direction TEXT,
  volume TEXT NOT NULL,
  state TEXT,
  stop_loss TEXT,
  take_profit TEXT,
  PRIMARY KEY (snapshot_id, order_id)
);
CREATE TABLE IF NOT EXISTS broker_deals (
  snapshot_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  order_id TEXT,
  client_id TEXT,
  position_id TEXT,
  symbol TEXT NOT NULL,
  volume TEXT NOT NULL,
  price TEXT,
  PRIMARY KEY (snapshot_id, deal_id)
);
CREATE TABLE IF NOT EXISTS broker_positions (
  snapshot_id TEXT NOT NULL,
  position_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT,
  volume TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, position_id)
);
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  reconciliation_run_id TEXT PRIMARY KEY,
  execution_request_id TEXT,
  execution_attempt_id TEXT,
  execution_identity TEXT,
  snapshot_id TEXT NOT NULL,
  state TEXT NOT NULL,
  resolution TEXT,
  engine_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  reconciled_at TEXT NOT NULL,
  agent_run_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  provider TEXT NOT NULL,
  repair_attempted INTEGER NOT NULL CHECK (repair_attempted = 0),
  retried INTEGER NOT NULL CHECK (retried = 0),
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reconciliation_findings (
  reconciliation_run_id TEXT NOT NULL,
  finding_index INTEGER NOT NULL,
  code TEXT NOT NULL,
  order_id TEXT,
  deal_id TEXT,
  position_id TEXT,
  symbol TEXT,
  broker_volume TEXT,
  PRIMARY KEY (reconciliation_run_id, finding_index)
);
CREATE TABLE IF NOT EXISTS xauusd_jobs (
  revision_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL,
  environment TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (job_id, sequence)
);
CREATE INDEX IF NOT EXISTS xauusd_jobs_identity ON xauusd_jobs(job_id, sequence);
CREATE TABLE IF NOT EXISTS xauusd_job_wakes (
  wake_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL,
  agent_run_id TEXT NOT NULL,
  runtime_thread_id TEXT NOT NULL,
  runtime_turn_id TEXT,
  payload_json TEXT NOT NULL,
  UNIQUE (job_id, scheduled_for)
);
CREATE TABLE IF NOT EXISTS trading_occurrences (
  occurrence_id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL,
  routine_run_id TEXT UNIQUE,
  thread_id TEXT NOT NULL,
  provider_turn_id TEXT,
  agent_run_id TEXT NOT NULL,
  instrument TEXT NOT NULL CHECK (instrument = 'XAUUSD'),
  environment TEXT NOT NULL CHECK (environment IN ('SIMULATOR', 'PAPER', 'LIVE')),
  provenance TEXT CHECK (
    provenance IS NULL OR provenance IN ('LIVE', 'STALE', 'SIMULATOR', 'UNAVAILABLE', 'REPLAY')
  ),
  snapshot_id TEXT,
  decision_id TEXT,
  order_intent_id TEXT,
  risk_decision_id TEXT,
  policy_decision_id TEXT,
  approval_id TEXT,
  execution_request_id TEXT,
  reconciliation_run_id TEXT,
  proposal_binding_hash TEXT,
  domain_status TEXT NOT NULL CHECK (domain_status IN (
    'turn_not_started',
    'observing',
    'no_trade',
    'proposed',
    'waiting_approval',
    'blocked',
    'submitted_unknown',
    'reconciled',
    'degraded',
    'desynced',
    'turn_failed'
  )),
  failure_code TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS trading_occurrences_routine ON trading_occurrences(routine_id);
CREATE TABLE IF NOT EXISTS trading_approval_transports (
  request_id TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL,
  agent_run_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  order_intent_id TEXT NOT NULL,
  risk_decision_id TEXT NOT NULL,
  policy_decision_id TEXT NOT NULL,
  proposal_binding TEXT NOT NULL,
  environment TEXT NOT NULL,
  instrument TEXT NOT NULL CHECK (instrument = 'XAUUSD'),
  approval_policy_version TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  max_age_ms INTEGER NOT NULL,
  assessment_json TEXT NOT NULL,
  resolved_fingerprint TEXT,
  approval_decision_id TEXT,
  assessment_state TEXT,
  assessment_reason TEXT,
  fact_json TEXT,
  decision_json TEXT
);
CREATE INDEX IF NOT EXISTS trading_approval_transports_binding ON trading_approval_transports(proposal_binding);
`;
