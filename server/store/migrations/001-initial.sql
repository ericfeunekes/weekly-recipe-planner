PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
) STRICT;

CREATE TABLE workspace (
  id TEXT PRIMARY KEY CHECK (id = 'household'),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  planner_version INTEGER NOT NULL CHECK (planner_version >= 0),
  sync_revision INTEGER NOT NULL CHECK (sync_revision >= 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE command_receipts (
  operation_kind TEXT NOT NULL CHECK (operation_kind IN (
    'planner_command',
    'planner_undo',
    'workspace_bootstrap',
    'chat_submit',
    'chat_retry'
  )),
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  decision_json TEXT NOT NULL CHECK (json_valid(decision_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (operation_kind, request_id)
) STRICT;

CREATE TABLE chat_turns (
  turn_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  turn_sequence INTEGER NOT NULL UNIQUE CHECK (turn_sequence > 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
  user_entry_id TEXT NOT NULL,
  context_json TEXT NOT NULL CHECK (json_valid(context_json)),
  input_planner_version INTEGER NOT NULL CHECK (input_planner_version >= 0),
  reply_entry_id TEXT UNIQUE,
  proposed_command_json TEXT CHECK (
    proposed_command_json IS NULL OR json_valid(proposed_command_json)
  ),
  mutation_outcome TEXT CHECK (
    mutation_outcome IS NULL OR mutation_outcome IN (
      'no_command',
      'applied',
      'version_conflict',
      'domain_rejected',
      'model_failed',
      'timed_out'
    )
  ),
  retry_of_turn_id TEXT REFERENCES chat_turns(turn_id),
  error_code TEXT,
  error_detail TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (
    (
      status = 'running'
      AND reply_entry_id IS NULL
      AND mutation_outcome IS NULL
      AND completed_at IS NULL
    )
    OR (
      status = 'completed'
      AND reply_entry_id IS NOT NULL
      AND mutation_outcome IS NOT NULL
      AND mutation_outcome IN (
        'no_command',
        'applied',
        'version_conflict',
        'domain_rejected'
      )
      AND completed_at IS NOT NULL
    )
    OR (
      status = 'failed'
      AND reply_entry_id IS NULL
      AND mutation_outcome IS NOT NULL
      AND mutation_outcome IN ('model_failed', 'timed_out')
      AND completed_at IS NOT NULL
    )
    OR (
      status = 'interrupted'
      AND reply_entry_id IS NULL
      AND mutation_outcome IS NULL
      AND completed_at IS NOT NULL
    )
  ),
  FOREIGN KEY (user_entry_id) REFERENCES transcript_entries(entry_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (reply_entry_id) REFERENCES transcript_entries(entry_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE transcript_entries (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  text TEXT NOT NULL,
  context_json TEXT CHECK (context_json IS NULL OR json_valid(context_json)),
  turn_id TEXT REFERENCES chat_turns(turn_id) DEFERRABLE INITIALLY DEFERRED,
  occurred_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX one_running_chat_turn
  ON chat_turns ((1))
  WHERE status = 'running';

CREATE TABLE planner_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('Household', 'Codex')),
  command_json TEXT NOT NULL CHECK (json_valid(command_json)),
  base_version INTEGER NOT NULL CHECK (base_version >= 0),
  result_version INTEGER NOT NULL UNIQUE CHECK (result_version = base_version + 1),
  summary TEXT NOT NULL,
  target TEXT NOT NULL,
  changes_json TEXT NOT NULL CHECK (json_valid(changes_json)),
  before_state_json TEXT NOT NULL CHECK (json_valid(before_state_json)),
  reverts_event_id TEXT REFERENCES planner_events(event_id),
  chat_turn_id TEXT REFERENCES chat_turns(turn_id),
  occurred_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX one_revert_per_event
  ON planner_events (reverts_event_id)
  WHERE reverts_event_id IS NOT NULL;
