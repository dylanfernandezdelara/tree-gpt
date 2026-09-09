-- Display-only search UI: url citations and web_search tool chips.
-- Never sent back upstream. Missing PUT keys must not NULL these columns.
ALTER TABLE messages ADD COLUMN citations TEXT CHECK (citations IS NULL OR length(citations) <= 4000);
ALTER TABLE messages ADD COLUMN tool_calls TEXT CHECK (tool_calls IS NULL OR length(tool_calls) <= 4000);
