CREATE TABLE mail_digest_windows(
  owner_sub TEXT NOT NULL,
  window_end INTEGER NOT NULL,
  cursor TEXT NOT NULL DEFAULT '',
  next_chunk INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')),
  claim_token TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_sub,window_end)
);
CREATE INDEX mail_digest_windows_open ON mail_digest_windows(state,window_end,owner_sub);
