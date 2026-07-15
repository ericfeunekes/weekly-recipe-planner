CREATE TRIGGER chat_turn_research_candidate_digest_bound
BEFORE UPDATE OF research_candidate_json ON chat_turns
WHEN OLD.research_candidate_json IS NULL
  AND NEW.research_candidate_json IS NOT NULL
  AND (
    json_type(NEW.research_candidate_json, '$.digestVersion') IS NOT 'integer'
    OR json_extract(NEW.research_candidate_json, '$.digestVersion') IS NOT 1
    OR json_type(NEW.research_candidate_json, '$.replacementDigest') IS NOT 'text'
    OR length(json_extract(NEW.research_candidate_json, '$.replacementDigest')) <> 64
    OR json_extract(NEW.research_candidate_json, '$.replacementDigest') <>
      lower(json_extract(NEW.research_candidate_json, '$.replacementDigest'))
    OR json_extract(NEW.research_candidate_json, '$.replacementDigest') GLOB '*[^0-9a-f]*'
    OR (SELECT COUNT(*) FROM json_each(NEW.research_candidate_json)) <> 7
    OR (
      SELECT COUNT(*)
      FROM json_each(json_extract(NEW.research_candidate_json, '$.source'))
    ) <> 4
  )
BEGIN
  SELECT RAISE(ABORT, 'research candidate reference must include one compact replacement digest');
END;

UPDATE workspace SET schema_version = 5 WHERE schema_version = 4;
