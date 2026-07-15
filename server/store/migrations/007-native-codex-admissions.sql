CREATE TABLE codex_thread_start_admission (
  id TEXT PRIMARY KEY CHECK (id = 'planner'),
  request_id TEXT NOT NULL CHECK (
    length(request_id) BETWEEN 1 AND 200
    AND length(trim(request_id)) > 0
    AND instr(request_id, char(0)) = 0
  ),
  owner_id TEXT NOT NULL CHECK (
    length(owner_id) BETWEEN 1 AND 200
    AND length(trim(owner_id)) > 0
    AND instr(owner_id, char(0)) = 0
  ),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64
    AND payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  expected_selection_revision INTEGER NOT NULL CHECK (
    expected_selection_revision >= 0
  ),
  newest_before_created_at_seconds INTEGER CHECK (
    newest_before_created_at_seconds IS NULL
    OR newest_before_created_at_seconds >= 0
  ),
  newest_before_root_thread_ids_json TEXT NOT NULL CHECK (
    json_valid(newest_before_root_thread_ids_json)
    AND json_type(newest_before_root_thread_ids_json, '$') = 'array'
    AND json_array_length(newest_before_root_thread_ids_json) BETWEEN 0 AND 100
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (
    (
      newest_before_created_at_seconds IS NULL
      AND json_array_length(newest_before_root_thread_ids_json) = 0
    )
    OR
    (
      newest_before_created_at_seconds IS NOT NULL
      AND json_array_length(newest_before_root_thread_ids_json) BETWEEN 1 AND 100
    )
  )
) STRICT;

CREATE TRIGGER codex_thread_start_admission_root_ids_insert
BEFORE INSERT ON codex_thread_start_admission
WHEN
  EXISTS (
    SELECT 1
    FROM json_each(NEW.newest_before_root_thread_ids_json)
    WHERE
      type <> 'text'
      OR length(value) NOT BETWEEN 1 AND 200
      OR length(trim(value)) = 0
      OR instr(value, char(0)) <> 0
  )
  OR EXISTS (
    SELECT 1
    FROM json_each(NEW.newest_before_root_thread_ids_json)
    GROUP BY value
    HAVING count(*) > 1
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid Codex thread-start root snapshot');
END;

CREATE TRIGGER codex_thread_start_admission_root_ids_update
BEFORE UPDATE OF newest_before_root_thread_ids_json
ON codex_thread_start_admission
WHEN
  EXISTS (
    SELECT 1
    FROM json_each(NEW.newest_before_root_thread_ids_json)
    WHERE
      type <> 'text'
      OR length(value) NOT BETWEEN 1 AND 200
      OR length(trim(value)) = 0
      OR instr(value, char(0)) <> 0
  )
  OR EXISTS (
    SELECT 1
    FROM json_each(NEW.newest_before_root_thread_ids_json)
    GROUP BY value
    HAVING count(*) > 1
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid Codex thread-start root snapshot');
END;

CREATE TABLE codex_turn_admissions (
  thread_id TEXT PRIMARY KEY CHECK (
    length(thread_id) BETWEEN 1 AND 200
    AND length(trim(thread_id)) > 0
    AND instr(thread_id, char(0)) = 0
  ),
  request_id TEXT NOT NULL UNIQUE CHECK (
    length(request_id) BETWEEN 1 AND 200
    AND length(trim(request_id)) > 0
    AND instr(request_id, char(0)) = 0
  ),
  owner_id TEXT NOT NULL CHECK (
    length(owner_id) BETWEEN 1 AND 200
    AND length(trim(owner_id)) > 0
    AND instr(owner_id, char(0)) = 0
  ),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64
    AND payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  client_user_message_id TEXT NOT NULL CHECK (
    length(client_user_message_id) BETWEEN 1 AND 200
    AND length(trim(client_user_message_id)) > 0
    AND instr(client_user_message_id, char(0)) = 0
  ),
  operation TEXT NOT NULL CHECK (operation IN ('start', 'steer')),
  expected_turn_id TEXT CHECK (
    expected_turn_id IS NULL
    OR (
      length(expected_turn_id) BETWEEN 1 AND 200
      AND length(trim(expected_turn_id)) > 0
      AND instr(expected_turn_id, char(0)) = 0
    )
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (
    (operation = 'start' AND expected_turn_id IS NULL)
    OR (operation = 'steer' AND expected_turn_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX codex_turn_admissions_created
  ON codex_turn_admissions (created_at, thread_id);

UPDATE workspace SET schema_version = 7 WHERE schema_version = 6;
