-- Account-wide generate counter (one row) that caps OpenRouter calls across
-- every user per fixed window. Complements openrouter_limits (per user) so a
-- wave of throwaway sign-ins cannot scale spend linearly.
CREATE TABLE openrouter_global_limits (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
