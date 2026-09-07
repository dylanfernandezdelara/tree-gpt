CREATE TABLE openrouter_limits (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
