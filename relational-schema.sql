CREATE TABLE audit_events (
  event_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  fingerprint TEXT NOT NULL,
  key_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > occurred_at)
);
CREATE TABLE audit_delivery (
  event_id TEXT PRIMARY KEY REFERENCES audit_events(event_id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER
);
CREATE INDEX audit_expiry ON audit_events(expires_at);
CREATE INDEX audit_delivery_due ON audit_delivery(available_at,lease_until);
CREATE TABLE audit_mutation_guard (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  valid INTEGER NOT NULL CONSTRAINT audit_mutation_rows_match CHECK(valid = 1)
);
CREATE TRIGGER audit_enqueue AFTER INSERT ON audit_events
BEGIN
  INSERT INTO audit_delivery(event_id,available_at) VALUES(NEW.event_id,NEW.occurred_at);
END;
CREATE TRIGGER audit_immutable BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT,'audit events are immutable');
END;
