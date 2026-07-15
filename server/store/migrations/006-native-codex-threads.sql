ALTER TABLE command_receipts RENAME TO command_receipts_v5;

CREATE TABLE command_receipts (
  operation_kind TEXT NOT NULL CHECK (operation_kind IN (
    'planner_command',
    'planner_chat_command',
    'planner_undo',
    'workspace_bootstrap',
    'chat_submit',
    'chat_retry',
    'embedded_codex_apply_planner_operations_v1',
    'native_codex_apply_planner_operations_v1',
    'global_codex_apply_planner_batch_v1'
  )),
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  decision_json TEXT NOT NULL CHECK (json_valid(decision_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (operation_kind, request_id)
) STRICT;

INSERT INTO command_receipts
  (operation_kind, request_id, payload_hash, http_status, decision_json, created_at)
SELECT operation_kind, request_id, payload_hash, http_status, decision_json, created_at
FROM command_receipts_v5;

DROP TABLE command_receipts_v5;

CREATE TABLE codex_thread_selection (
  id TEXT PRIMARY KEY CHECK (id = 'planner'),
  selected_thread_id TEXT CHECK (
    selected_thread_id IS NULL OR (
      length(selected_thread_id) BETWEEN 1 AND 200
      AND instr(selected_thread_id, char(0)) = 0
    )
  ),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

INSERT INTO codex_thread_selection
  (id, selected_thread_id, revision, updated_at)
VALUES ('planner', NULL, 0, 0);

CREATE TABLE codex_native_tool_calls (
  thread_id TEXT NOT NULL CHECK (
    length(thread_id) BETWEEN 1 AND 200 AND instr(thread_id, char(0)) = 0
  ),
  turn_id TEXT NOT NULL CHECK (
    length(turn_id) BETWEEN 1 AND 200 AND instr(turn_id, char(0)) = 0
  ),
  call_id TEXT NOT NULL CHECK (
    length(call_id) BETWEEN 1 AND 200 AND instr(call_id, char(0)) = 0
  ),
  callback_identity_hash TEXT NOT NULL UNIQUE CHECK (
    length(callback_identity_hash) = 64
  ),
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 32),
  tool TEXT NOT NULL CHECK (tool IN ('read', 'preview', 'apply')),
  argument_hash TEXT NOT NULL CHECK (length(argument_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'rejected')),
  result_code TEXT,
  operation_kind TEXT CHECK (
    operation_kind IS NULL OR operation_kind = 'native_codex_apply_planner_operations_v1'
  ),
  request_id TEXT,
  event_id TEXT REFERENCES planner_events(event_id),
  base_planner_version INTEGER CHECK (
    base_planner_version IS NULL OR base_planner_version >= 0
  ),
  result_planner_version INTEGER CHECK (
    result_planner_version IS NULL OR result_planner_version >= 0
  ),
  result_envelope_json TEXT CHECK (
    result_envelope_json IS NULL OR (
      json_valid(result_envelope_json)
      AND json_type(result_envelope_json, '$') = 'object'
      AND json_extract(result_envelope_json, '$.schemaVersion') = 1
      AND json_type(result_envelope_json, '$.ok') IN ('true', 'false')
      AND json_type(result_envelope_json, '$.callId') = 'text'
      AND json_type(result_envelope_json, '$.plannerVersion') = 'integer'
      AND json_extract(result_envelope_json, '$.plannerVersion') >= 0
      AND json_type(result_envelope_json, '$.syncRevision') = 'integer'
      AND json_extract(result_envelope_json, '$.syncRevision') >= 0
      AND json_type(result_envelope_json, '$.serverTime') = 'integer'
      AND json_extract(result_envelope_json, '$.serverTime') >= 0
      AND (
        json_type(result_envelope_json, '$.data') IS NOT NULL
        OR json_type(result_envelope_json, '$.error') = 'object'
      )
    )
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= created_at),
  PRIMARY KEY (thread_id, turn_id, call_id),
  UNIQUE (thread_id, turn_id, sequence),
  CHECK (
    (
      status = 'running'
      AND result_code IS NULL
      AND result_envelope_json IS NULL
      AND completed_at IS NULL
    )
    OR
    (
      status <> 'running'
      AND result_code IS NOT NULL
      AND result_envelope_json IS NOT NULL
      AND completed_at IS NOT NULL
    )
  ),
  CHECK (
    operation_kind IS NULL OR (
      tool = 'apply'
      AND request_id IS NOT NULL
      AND base_planner_version IS NOT NULL
      AND result_planner_version IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX codex_native_tool_calls_thread_turn_sequence
  ON codex_native_tool_calls (thread_id, turn_id, sequence);

UPDATE workspace SET schema_version = 6 WHERE schema_version = 5;
