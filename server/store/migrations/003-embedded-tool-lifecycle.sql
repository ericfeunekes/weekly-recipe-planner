ALTER TABLE chat_turns
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'normal'
  CHECK (mode IN ('normal', 'recovery'));

ALTER TABLE chat_turns
  ADD COLUMN completion_token_hash TEXT
  CHECK (completion_token_hash IS NULL OR length(completion_token_hash) = 64);

ALTER TABLE chat_turns
  ADD COLUMN app_server_thread_id TEXT;

ALTER TABLE chat_turns
  ADD COLUMN app_server_turn_id TEXT
  CHECK (
    (app_server_thread_id IS NULL AND app_server_turn_id IS NULL)
    OR
    (app_server_thread_id IS NOT NULL AND app_server_turn_id IS NOT NULL)
  );

ALTER TABLE chat_turns
  ADD COLUMN foreground_authority_json TEXT NOT NULL DEFAULT '[]'
  CHECK (
    json_valid(foreground_authority_json)
    AND json_type(foreground_authority_json) = 'array'
  );

ALTER TABLE chat_turns
  ADD COLUMN accepted_effect_count INTEGER NOT NULL DEFAULT 0
  CHECK (accepted_effect_count >= 0);

ALTER TABLE chat_turns
  ADD COLUMN last_effect_sequence INTEGER NOT NULL DEFAULT 0
  CHECK (
    last_effect_sequence >= 0
    AND last_effect_sequence = accepted_effect_count
  );

ALTER TABLE chat_turns
  ADD COLUMN recovery_of_turn_id TEXT REFERENCES chat_turns(turn_id);

ALTER TABLE chat_turns
  ADD COLUMN terminal_outcome TEXT
  CHECK (
    terminal_outcome IS NULL OR terminal_outcome IN (
      'completed_no_effect',
      'completed_with_effects',
      'failed_no_effect',
      'failed_after_effect',
      'interrupted_no_effect',
      'interrupted_after_effect',
      'recovery_completed',
      'recovery_failed'
    )
  );

UPDATE chat_turns
SET
  accepted_effect_count = CASE
    WHEN status = 'completed' AND mutation_outcome = 'applied' THEN 1
    ELSE 0
  END,
  last_effect_sequence = CASE
    WHEN status = 'completed' AND mutation_outcome = 'applied' THEN 1
    ELSE 0
  END,
  terminal_outcome = CASE
    WHEN status = 'completed' AND mutation_outcome = 'applied'
      THEN 'completed_with_effects'
    WHEN status = 'completed'
      THEN 'completed_no_effect'
    WHEN status = 'failed'
      THEN 'failed_no_effect'
    WHEN status = 'interrupted'
      THEN 'interrupted_no_effect'
    ELSE NULL
  END;

CREATE TRIGGER chat_turn_app_server_binding_immutable
BEFORE UPDATE OF app_server_thread_id, app_server_turn_id ON chat_turns
WHEN
  OLD.app_server_thread_id IS NOT NULL
  AND (
    NEW.app_server_thread_id IS NOT OLD.app_server_thread_id
    OR NEW.app_server_turn_id IS NOT OLD.app_server_turn_id
  )
BEGIN
  SELECT RAISE(ABORT, 'app-server turn binding is immutable');
END;

CREATE TRIGGER chat_turn_foreground_authority_immutable
BEFORE UPDATE OF foreground_authority_json ON chat_turns
WHEN NEW.foreground_authority_json IS NOT OLD.foreground_authority_json
BEGIN
  SELECT RAISE(ABORT, 'foreground authority is immutable');
END;

CREATE TRIGGER chat_turn_mode_linkage_insert
BEFORE INSERT ON chat_turns
WHEN
  (NEW.mode = 'normal' AND NEW.recovery_of_turn_id IS NOT NULL)
  OR (NEW.mode = 'recovery' AND NEW.recovery_of_turn_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'chat turn mode and recovery linkage disagree');
END;

CREATE TRIGGER chat_turn_mode_linkage_update
BEFORE UPDATE OF mode, recovery_of_turn_id ON chat_turns
WHEN
  (NEW.mode = 'normal' AND NEW.recovery_of_turn_id IS NOT NULL)
  OR (NEW.mode = 'recovery' AND NEW.recovery_of_turn_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'chat turn mode and recovery linkage disagree');
END;

CREATE TABLE planner_tool_calls (
  turn_id TEXT NOT NULL REFERENCES chat_turns(turn_id) ON DELETE RESTRICT,
  tool_call_id TEXT NOT NULL,
  app_server_thread_id TEXT NOT NULL,
  app_server_turn_id TEXT NOT NULL,
  app_server_call_id TEXT NOT NULL,
  callback_identity_hash TEXT NOT NULL UNIQUE CHECK (length(callback_identity_hash) = 64),
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 32),
  completion_token_hash TEXT NOT NULL CHECK (length(completion_token_hash) = 64),
  tool TEXT NOT NULL CHECK (tool IN ('read', 'preview', 'apply')),
  argument_hash TEXT NOT NULL CHECK (length(argument_hash) = 64),
  status TEXT NOT NULL CHECK (
    status IN ('running', 'succeeded', 'rejected', 'cancelled', 'timed_out', 'abandoned')
  ),
  result_code TEXT,
  operation_kind TEXT CHECK (
    operation_kind IS NULL OR operation_kind = 'embedded_codex_apply_planner_operations_v1'
  ),
  request_id TEXT,
  event_id TEXT REFERENCES planner_events(event_id),
  base_planner_version INTEGER CHECK (
    base_planner_version IS NULL OR base_planner_version >= 0
  ),
  result_planner_version INTEGER CHECK (
    result_planner_version IS NULL OR result_planner_version >= 0
  ),
  effect_sequence INTEGER CHECK (effect_sequence IS NULL OR effect_sequence >= 1),
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
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (turn_id, tool_call_id),
  UNIQUE (turn_id, sequence),
  CHECK (
    (
      status = 'running'
      AND result_envelope_json IS NULL
      AND completed_at IS NULL
    )
    OR
    (
      status <> 'running'
      AND result_envelope_json IS NOT NULL
      AND completed_at IS NOT NULL
    )
  ),
  CHECK (
    effect_sequence IS NULL
    OR (
      status = 'succeeded'
      AND tool = 'apply'
      AND operation_kind = 'embedded_codex_apply_planner_operations_v1'
      AND request_id IS NOT NULL
      AND event_id IS NOT NULL
      AND base_planner_version IS NOT NULL
      AND result_planner_version IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX planner_tool_calls_turn_sequence
  ON planner_tool_calls (turn_id, sequence);

UPDATE workspace SET schema_version = 3 WHERE schema_version = 2;
