-- Scripts belong to one signed-in person. There is no sharing, so ownership is
-- a plain column and every query filters on it.
CREATE TABLE scripts (
  id         TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The sidebar lists one person's scripts, most recently edited first.
CREATE INDEX scripts_by_user ON scripts (user_email, updated_at DESC);
