ALTER TABLE chat_turns
  ADD COLUMN research_kind TEXT NOT NULL DEFAULT 'none'
  CHECK (research_kind IN ('none', 'sourced_recipe'));

ALTER TABLE chat_turns
  ADD COLUMN research_candidate_json TEXT
  CHECK (
    (research_kind = 'none' AND research_candidate_json IS NULL)
    OR
    (
      research_kind = 'sourced_recipe'
      AND (
        research_candidate_json IS NULL
        OR (
          json_valid(research_candidate_json)
          AND json_type(research_candidate_json) = 'object'
          AND json_extract(research_candidate_json, '$.schemaVersion') = 1
          AND json_type(research_candidate_json, '$.candidateId') = 'text'
          AND json_type(research_candidate_json, '$.title') = 'text'
          AND json_type(research_candidate_json, '$.source') = 'object'
          AND json_type(research_candidate_json, '$.stepCount') = 'integer'
        )
      )
    )
  );

CREATE TRIGGER chat_turn_research_kind_immutable
BEFORE UPDATE OF research_kind ON chat_turns
WHEN NEW.research_kind IS NOT OLD.research_kind
BEGIN
  SELECT RAISE(ABORT, 'chat turn research kind is immutable');
END;

CREATE TRIGGER chat_turn_research_candidate_insert_null
BEFORE INSERT ON chat_turns
WHEN NEW.research_candidate_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'research candidate must attach after turn insert');
END;

CREATE TRIGGER chat_turn_research_candidate_once
BEFORE UPDATE OF research_candidate_json ON chat_turns
WHEN OLD.research_candidate_json IS NOT NULL
  AND NEW.research_candidate_json IS NOT OLD.research_candidate_json
BEGIN
  SELECT RAISE(ABORT, 'research candidate reference is immutable');
END;

CREATE TRIGGER chat_turn_research_lifecycle_insert
BEFORE INSERT ON chat_turns
WHEN
  (NEW.mode = 'recovery' AND NEW.research_kind <> 'none')
  OR (NEW.mode = 'recovery' AND NEW.research_candidate_json IS NOT NULL)
  OR (NEW.research_kind = 'none' AND NEW.research_candidate_json IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'chat turn research lifecycle is invalid');
END;

CREATE TRIGGER chat_turn_research_lifecycle_update
BEFORE UPDATE OF mode, research_kind, research_candidate_json ON chat_turns
WHEN
  (NEW.mode = 'recovery' AND NEW.research_kind <> 'none')
  OR (NEW.mode = 'recovery' AND NEW.research_candidate_json IS NOT NULL)
  OR (NEW.research_kind = 'none' AND NEW.research_candidate_json IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'chat turn research lifecycle is invalid');
END;

UPDATE workspace SET schema_version = 4 WHERE schema_version = 3;
