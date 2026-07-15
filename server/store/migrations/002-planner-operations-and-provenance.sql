ALTER TABLE command_receipts RENAME TO command_receipts_v1;

CREATE TABLE command_receipts (
  operation_kind TEXT NOT NULL CHECK (operation_kind IN (
    'planner_command',
    'planner_chat_command',
    'planner_undo',
    'workspace_bootstrap',
    'chat_submit',
    'chat_retry',
    'embedded_codex_apply_planner_operations_v1',
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
FROM command_receipts_v1;

DROP TABLE command_receipts_v1;

ALTER TABLE planner_events RENAME TO planner_events_v1;

CREATE TABLE planner_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('Household', 'Codex')),
  actor_source TEXT NOT NULL CHECK (
    actor_source IN ('browser', 'embedded_legacy', 'embedded', 'global')
  ),
  admission TEXT NOT NULL CHECK (
    admission IN (
      'same_origin_http_v1',
      'structured_output_v1',
      'app_server_dynamic_v1',
      'same_uid_uds_v1'
    )
  ),
  command_json TEXT NOT NULL CHECK (json_valid(command_json)),
  base_version INTEGER NOT NULL CHECK (base_version >= 0),
  result_version INTEGER NOT NULL UNIQUE CHECK (result_version = base_version + 1),
  summary TEXT NOT NULL,
  target TEXT NOT NULL,
  changes_json TEXT NOT NULL CHECK (json_valid(changes_json)),
  before_state_json TEXT NOT NULL CHECK (json_valid(before_state_json)),
  reverts_event_id TEXT REFERENCES planner_events(event_id),
  chat_turn_id TEXT REFERENCES chat_turns(turn_id),
  occurred_at INTEGER NOT NULL,
  CHECK (
    (actor = 'Household' AND actor_source = 'browser' AND admission = 'same_origin_http_v1')
    OR
    (actor = 'Codex' AND actor_source = 'embedded_legacy' AND admission = 'structured_output_v1')
    OR
    (actor = 'Codex' AND actor_source = 'embedded' AND admission = 'app_server_dynamic_v1')
    OR
    (actor = 'Codex' AND actor_source = 'global' AND admission = 'same_uid_uds_v1')
  )
) STRICT;

INSERT INTO planner_events
  (sequence, event_id, request_id, actor, actor_source, admission, command_json,
   base_version, result_version, summary, target, changes_json, before_state_json,
   reverts_event_id, chat_turn_id, occurred_at)
SELECT sequence, event_id, request_id, actor,
  CASE actor WHEN 'Household' THEN 'browser' ELSE 'embedded_legacy' END,
  CASE actor WHEN 'Household' THEN 'same_origin_http_v1' ELSE 'structured_output_v1' END,
  command_json, base_version, result_version, summary, target, changes_json,
  before_state_json, reverts_event_id, chat_turn_id, occurred_at
FROM planner_events_v1
ORDER BY sequence;

DROP TABLE planner_events_v1;

CREATE UNIQUE INDEX one_revert_per_event
  ON planner_events (reverts_event_id)
  WHERE reverts_event_id IS NOT NULL;

UPDATE workspace SET schema_version = 2 WHERE schema_version = 1;
