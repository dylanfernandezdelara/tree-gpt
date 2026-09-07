-- Reasoning traces are no longer stored or echoed (plain chat sends no
-- tools, so there is no continuity to preserve). Dropping the column is
-- intentionally one-way: the blobs are disposable and were the latency
-- problem. New code names explicit columns, so it runs fine whether or
-- not this migration has applied yet.
ALTER TABLE messages DROP COLUMN reasoning_details;
