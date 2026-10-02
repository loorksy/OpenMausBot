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
  execution_state TEXT CHECK (
    execution_state IS NULL OR execution_state IN (
      'NOT_SUBMITTED',
      'SUBMISSION_REJECTED',
      'SUBMISSION_ACCEPTED',
      'SUBMISSION_UNKNOWN',
      'FILL_REPORTED'
    )
  ),
  reconciliation_state TEXT CHECK (
    reconciliation_state IS NULL OR reconciliation_state IN (
      'RECONCILED',
      'DEGRADED',
      'DESYNCED',
      'UNKNOWN'
    )
  ),
  proposal_binding_hash TEXT,
  gate_decision_id TEXT,
  exit_execution_request_id TEXT,
  exit_execution_state TEXT CHECK (
    exit_execution_state IS NULL OR exit_execution_state IN (
      'NOT_SUBMITTED',
      'SUBMISSION_REJECTED',
      'SUBMISSION_ACCEPTED',
      'SUBMISSION_UNKNOWN',
      'FILL_REPORTED'
    )
  ),
  exit_broker_called INTEGER,
  exit_close_position_id TEXT,
  exit_quantity TEXT,
  exit_failure_code TEXT,
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
CREATE TABLE IF NOT EXISTS trading_memory (
  record_id TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL,
  agent_run_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('FACT', 'INTERPRETATION', 'USER_FEEDBACK')),
  revision INTEGER NOT NULL,
  supersedes TEXT,
  recorded_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trading_memory_occurrence ON trading_memory(occurrence_id, revision);
CREATE TABLE IF NOT EXISTS trading_learning (
  revision_id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kill_switch_state (
  environment TEXT NOT NULL,
  agent_run_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (environment, agent_run_id)
);
CREATE TABLE IF NOT EXISTS trading_decisions (
  decision_id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trading_risk_decisions (
  risk_decision_id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trading_policy_decisions (
  policy_decision_id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trading_gate_decisions (
  gate_decision_id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trading_monitoring_cycles (
  cycle_id TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL,
  agent_run_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trading_monitoring_cycles_occurrence
  ON trading_monitoring_cycles(occurrence_id, observed_at);
CREATE TABLE IF NOT EXISTS trading_reviews (
  review_id TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL,
  agent_run_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  revision INTEGER NOT NULL,
  supersedes TEXT,
  recorded_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (occurrence_id, revision)
);
CREATE INDEX IF NOT EXISTS trading_reviews_occurrence
  ON trading_reviews(occurrence_id, revision);
`;
