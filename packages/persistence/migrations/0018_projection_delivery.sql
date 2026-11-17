-- Deploy only with legacy projectors and writers quiesced; never renumber published cursors.
LOCK TABLE operations, operation_events, operation_event_envelopes, operation_views, projection_cursors,
  work_steps, step_attempts, approval_requests, claims, result_documents IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE bad text; source_table text;
BEGIN
 SELECT e.id INTO bad FROM operation_events e LEFT JOIN operations o ON o.id=e.operation_id
 WHERE o.id IS NULL OR o.workspace_id<>e.workspace_id LIMIT 1;
 IF bad IS NOT NULL THEN RAISE EXCEPTION 'Invalid operation event: %',bad; END IF;
 FOREACH source_table IN ARRAY ARRAY['work_steps','step_attempts','approval_requests','claims','result_documents'] LOOP
  EXECUTE format('SELECT s.operation_id FROM %I s LEFT JOIN operations o ON o.id=s.operation_id WHERE o.id IS NULL OR (to_jsonb(s) ? ''workspace_id'' AND (to_jsonb(s)->>''workspace_id'') IS DISTINCT FROM o.workspace_id) LIMIT 1',source_table) INTO bad;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Invalid historical source % for operation %',source_table,bad; END IF;
 END LOOP;
 SELECT x.event_id INTO bad FROM operation_event_envelopes x
 LEFT JOIN operation_events e ON e.id=x.event_id
 WHERE e.id IS NULL OR e.operation_id<>x.operation_id OR e.workspace_id<>x.workspace_id OR x.sequence<1 LIMIT 1;
 IF bad IS NOT NULL THEN RAISE EXCEPTION 'Invalid historical envelope: %',bad; END IF;
 SELECT operation_id INTO bad FROM operation_event_envelopes GROUP BY operation_id
 HAVING min(sequence)<>1 OR max(sequence)<>count(*) LIMIT 1;
 IF bad IS NOT NULL THEN RAISE EXCEPTION 'Non-contiguous historical envelopes: %',bad; END IF;
 SELECT c.operation_id INTO bad FROM projection_cursors c LEFT JOIN operations o ON o.id=c.operation_id
 LEFT JOIN (SELECT operation_id,max(sequence) n FROM operation_event_envelopes GROUP BY operation_id) x ON x.operation_id=c.operation_id
 WHERE o.id IS NULL OR c.last_sequence<>coalesce(x.n,0) LIMIT 1;
 IF bad IS NOT NULL THEN RAISE EXCEPTION 'Invalid historical cursor: %',bad; END IF;
 SELECT x.operation_id INTO bad FROM operation_event_envelopes x LEFT JOIN projection_cursors c ON c.operation_id=x.operation_id
 WHERE c.operation_id IS NULL LIMIT 1;
 IF bad IS NOT NULL THEN RAISE EXCEPTION 'Missing historical cursor: %',bad; END IF;
 SELECT v.operation_id INTO bad FROM operation_views v LEFT JOIN operations o ON o.id=v.operation_id
 LEFT JOIN projection_cursors c ON c.operation_id=v.operation_id
 WHERE o.id IS NULL OR v.workspace_id<>o.workspace_id OR v.last_sequence<>coalesce(c.last_sequence,0) LIMIT 1;
 IF bad IS NOT NULL THEN RAISE EXCEPTION 'Invalid historical view: %',bad; END IF;
END $$;

CREATE TABLE projection_work (
 operation_id text PRIMARY KEY, workspace_id text NOT NULL,
 dirty boolean NOT NULL DEFAULT true, next_event_sequence integer NOT NULL DEFAULT 0
);
CREATE INDEX projection_work_dirty_idx ON projection_work(dirty,operation_id);
ALTER TABLE operation_events ADD COLUMN projection_sequence integer;
UPDATE operation_events e SET projection_sequence=x.sequence FROM operation_event_envelopes x WHERE x.event_id=e.id;
WITH pending AS (
 SELECT e.id, coalesce(m.max_sequence,0)+row_number() OVER (PARTITION BY e.operation_id ORDER BY e.occurred_at,e.id) AS seq
 FROM operation_events e LEFT JOIN (SELECT operation_id,max(sequence) AS max_sequence FROM operation_event_envelopes GROUP BY operation_id) m ON m.operation_id=e.operation_id
 WHERE e.projection_sequence IS NULL
) UPDATE operation_events e SET projection_sequence=p.seq FROM pending p WHERE p.id=e.id;
ALTER TABLE operation_events ALTER COLUMN projection_sequence SET DEFAULT 0;
ALTER TABLE operation_events ALTER COLUMN projection_sequence SET NOT NULL;
CREATE UNIQUE INDEX events_operation_projection_sequence_unique ON operation_events(operation_id,projection_sequence);
INSERT INTO projection_work(operation_id,workspace_id,dirty,next_event_sequence)
 SELECT o.id,o.workspace_id,true,coalesce(max(e.projection_sequence),0) FROM operations o LEFT JOIN operation_events e ON e.operation_id=o.id GROUP BY o.id,o.workspace_id;

CREATE FUNCTION projection_mark_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb; old_data jsonb; op_id text; ws text; supplied_ws text;
BEGIN
 row_data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 old_data := CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE row_data END;
 op_id := CASE WHEN TG_TABLE_NAME='operations' THEN row_data->>'id' ELSE row_data->>'operation_id' END;
 IF TG_TABLE_NAME='operations' AND TG_OP='DELETE' THEN RAISE EXCEPTION 'Operation deletion requires projection cleanup'; END IF;
 IF TG_OP='UPDATE' AND ((CASE WHEN TG_TABLE_NAME='operations' THEN old_data->>'id' ELSE old_data->>'operation_id' END) IS DISTINCT FROM op_id OR old_data->>'workspace_id' IS DISTINCT FROM row_data->>'workspace_id') THEN
  RAISE EXCEPTION 'Projection source identity cannot change';
 END IF;
 IF TG_TABLE_NAME='operations' THEN ws := row_data->>'workspace_id';
 ELSE SELECT workspace_id INTO ws FROM operations WHERE id=op_id; END IF;
 supplied_ws := row_data->>'workspace_id';
 IF ws IS NULL OR (supplied_ws IS NOT NULL AND supplied_ws<>ws) THEN RAISE EXCEPTION 'Projection source workspace mismatch for %',op_id; END IF;
 INSERT INTO projection_work(operation_id,workspace_id,dirty) VALUES(op_id,ws,true)
 ON CONFLICT(operation_id) DO UPDATE SET dirty=true WHERE projection_work.workspace_id=excluded.workspace_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Projection work workspace mismatch for %',op_id; END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION projection_sequence_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ws text; seq integer;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Operation events are append-only'; END IF;
 SELECT workspace_id INTO ws FROM operations WHERE id=NEW.operation_id;
 IF ws IS NULL OR ws<>NEW.workspace_id THEN RAISE EXCEPTION 'Event workspace mismatch for %',NEW.operation_id; END IF;
 UPDATE projection_work SET next_event_sequence=next_event_sequence+1,dirty=true
 WHERE operation_id=NEW.operation_id AND workspace_id=ws RETURNING next_event_sequence INTO seq;
 IF seq IS NULL THEN RAISE EXCEPTION 'Projection work missing for %',NEW.operation_id; END IF;
 NEW.projection_sequence := seq;
 RETURN NEW;
END $$;
CREATE TRIGGER projection_event_sequence BEFORE INSERT OR UPDATE OR DELETE ON operation_events FOR EACH ROW EXECUTE FUNCTION projection_sequence_event();
CREATE TRIGGER projection_dirty AFTER INSERT OR UPDATE OR DELETE ON operations FOR EACH ROW EXECUTE FUNCTION projection_mark_dirty();
CREATE TRIGGER projection_dirty AFTER INSERT OR UPDATE OR DELETE ON work_steps FOR EACH ROW EXECUTE FUNCTION projection_mark_dirty();
CREATE TRIGGER projection_dirty AFTER INSERT OR UPDATE OR DELETE ON step_attempts FOR EACH ROW EXECUTE FUNCTION projection_mark_dirty();
CREATE TRIGGER projection_dirty AFTER INSERT OR UPDATE OR DELETE ON approval_requests FOR EACH ROW EXECUTE FUNCTION projection_mark_dirty();
CREATE TRIGGER projection_dirty AFTER INSERT OR UPDATE OR DELETE ON claims FOR EACH ROW EXECUTE FUNCTION projection_mark_dirty();
CREATE TRIGGER projection_dirty AFTER INSERT OR UPDATE OR DELETE ON result_documents FOR EACH ROW EXECUTE FUNCTION projection_mark_dirty();
