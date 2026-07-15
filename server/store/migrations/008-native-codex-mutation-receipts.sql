CREATE TABLE codex_native_mutation_receipts (
  receipt_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('new', 'send')),
  request_id TEXT NOT NULL CHECK (
    length(request_id) BETWEEN 1 AND 200
    AND length(trim(request_id)) > 0
    AND instr(request_id, char(0)) = 0
  ),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64
    AND payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  thread_id TEXT NOT NULL CHECK (
    length(thread_id) BETWEEN 1 AND 200
    AND length(trim(thread_id)) > 0
    AND instr(thread_id, char(0)) = 0
  ),
  client_user_message_id TEXT CHECK (
    client_user_message_id IS NULL OR (
      length(client_user_message_id) BETWEEN 1 AND 200
      AND length(trim(client_user_message_id)) > 0
      AND instr(client_user_message_id, char(0)) = 0
    )
  ),
  turn_id TEXT CHECK (
    turn_id IS NULL OR (
      length(turn_id) BETWEEN 1 AND 200
      AND length(trim(turn_id)) > 0
      AND instr(turn_id, char(0)) = 0
    )
  ),
  selection_revision INTEGER CHECK (
    selection_revision IS NULL OR selection_revision >= 0
  ),
  completed_at INTEGER NOT NULL CHECK (completed_at >= 0),
  UNIQUE (scope, request_id),
  CHECK (
    (scope = 'new' AND client_user_message_id IS NULL
      AND turn_id IS NULL AND selection_revision IS NOT NULL)
    OR
    (scope = 'send' AND client_user_message_id IS NOT NULL
      AND turn_id IS NOT NULL AND selection_revision IS NULL)
  )
) STRICT;

CREATE TRIGGER codex_thread_start_admission_reject_settled_insert
BEFORE INSERT ON codex_thread_start_admission
WHEN EXISTS (
  SELECT 1 FROM codex_native_mutation_receipts
  WHERE scope = 'new' AND request_id = NEW.request_id
)
BEGIN
  SELECT RAISE(ABORT, 'settled Codex thread-start request cannot be readmitted');
END;

CREATE TRIGGER codex_thread_start_admission_reject_settled_update
BEFORE UPDATE OF request_id, payload_hash ON codex_thread_start_admission
WHEN EXISTS (
  SELECT 1 FROM codex_native_mutation_receipts
  WHERE scope = 'new' AND request_id = NEW.request_id
)
BEGIN
  SELECT RAISE(ABORT, 'settled Codex thread-start request cannot be readmitted');
END;

CREATE TRIGGER codex_turn_admission_reject_settled_insert
BEFORE INSERT ON codex_turn_admissions
WHEN EXISTS (
  SELECT 1 FROM codex_native_mutation_receipts
  WHERE scope = 'send' AND request_id = NEW.request_id
)
BEGIN
  SELECT RAISE(ABORT, 'settled Codex turn request cannot be readmitted');
END;

CREATE TRIGGER codex_turn_admission_reject_settled_update
BEFORE UPDATE OF request_id, payload_hash ON codex_turn_admissions
WHEN EXISTS (
  SELECT 1 FROM codex_native_mutation_receipts
  WHERE scope = 'send' AND request_id = NEW.request_id
)
BEGIN
  SELECT RAISE(ABORT, 'settled Codex turn request cannot be readmitted');
END;

UPDATE workspace SET schema_version = 8 WHERE schema_version = 7;
