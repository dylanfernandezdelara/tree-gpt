-- Conversation tree: a message is an immutable node (parent_id / root_id /
-- depth); a chat is a named pointer to a leaf. The linear transcript is the
-- root-to-leaf path. Shared prefixes are one row; fork = a second pointer.
--
-- Backfill orders each old chat by (created_at, rowid). Old PUT reinserted
-- the array on every save, so rowid is the reliable tiebreak — (created_at,
-- id) is not, because newExchange() gives a turn and its reply the same
-- timestamp and random ids.

CREATE TABLE messages_v2 (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  root_id TEXT NOT NULL,
  parent_id TEXT,
  depth INTEGER NOT NULL CHECK (depth >= 0 AND depth < 80),
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('pending','done')),
  content TEXT NOT NULL CHECK (length(content) <= 8000),
  reasoning TEXT CHECK (reasoning IS NULL OR length(reasoning) <= 4000),
  created_at INTEGER NOT NULL,
  CHECK ((parent_id IS NULL) = (depth = 0)),
  CHECK ((parent_id IS NULL) = (root_id = id)),
  CHECK (status = 'done' OR role = 'assistant'),
  CHECK (role = 'assistant' OR reasoning IS NULL),
  UNIQUE (id, user_id),
  FOREIGN KEY (parent_id, user_id) REFERENCES messages_v2(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (root_id, user_id) REFERENCES messages_v2(id, user_id) ON DELETE CASCADE
);

CREATE TABLE chats_v2 (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  root_id TEXT,      -- NULL only while the chat has no messages
  leaf_id TEXT,      -- NULL only while the chat has no messages
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((root_id IS NULL) = (leaf_id IS NULL)),
  FOREIGN KEY (leaf_id, user_id) REFERENCES messages_v2(id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (root_id, user_id) REFERENCES messages_v2(id, user_id) ON DELETE CASCADE
);

-- Parent-first insert so immediate self-FKs succeed under foreign_keys=ON.
INSERT INTO messages_v2 (id, user_id, root_id, parent_id, depth, role, status, content, reasoning, created_at)
SELECT m.id, c.user_id,
       FIRST_VALUE(m.id) OVER w, LAG(m.id) OVER w, ROW_NUMBER() OVER w - 1,
       m.role, 'done', m.content, substr(m.reasoning, 1, 4000), m.created_at
FROM messages m JOIN chats c ON c.id = m.chat_id
WINDOW w AS (PARTITION BY m.chat_id ORDER BY m.created_at, m.rowid)
ORDER BY m.chat_id, m.created_at, m.rowid;

INSERT INTO chats_v2 (id, user_id, root_id, leaf_id, title, created_at, updated_at)
SELECT c.id, c.user_id, last.root_id, last.id, c.title, c.created_at, c.updated_at
FROM chats c LEFT JOIN (
  SELECT id, root_id, chat_id, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY depth DESC) AS rn
  FROM messages_v2 JOIN messages USING (id)
) last ON last.chat_id = c.id AND last.rn = 1;

DROP TABLE messages;
DROP TABLE chats;
ALTER TABLE messages_v2 RENAME TO messages;
ALTER TABLE chats_v2 RENAME TO chats;

-- Indexes after the rename: SQLite keeps index names across RENAME TABLE.
CREATE INDEX messages_parent ON messages (parent_id);
CREATE INDEX messages_root ON messages (user_id, root_id);
CREATE INDEX chats_user_updated ON chats (user_id, updated_at DESC);
CREATE INDEX chats_root ON chats (root_id);
