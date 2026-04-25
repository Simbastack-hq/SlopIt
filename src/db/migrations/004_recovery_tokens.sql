-- Recovery tokens for the two-step email recovery flow.
--
-- Step 1 (POST /recover): platform asks core for a token via
-- requestRecoveryByEmail(); core inserts a row with the sha256 hash of
-- the plaintext token. Plaintext is returned to platform once and only
-- once so the email body can include it; never persisted.
--
-- Step 2 (GET /recover/confirm): platform passes the plaintext back to
-- consumeRecoveryToken(); core hashes, looks up, validates expiry +
-- consumed_at, marks consumed, then atomically rotates API keys for all
-- blogs currently associated with the email.
--
-- Two-step is mandatory: without a token, anyone who knows or guesses a
-- registered email could DoS that account by triggering an immediate
-- key rotation. The token proves inbox access.

CREATE TABLE IF NOT EXISTS recovery_tokens (
  token_hash    TEXT PRIMARY KEY,                         -- sha256 of plaintext token
  email         TEXT NOT NULL,                            -- normalized (trim + lowercase)
  expires_at    INTEGER NOT NULL,                         -- unix epoch ms
  consumed_at   INTEGER,                                  -- null until consumed; single-use
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cleanup-on-insert sweeps expired rows, so this index keeps that fast
-- and bounded as the table grows under steady-state recovery traffic.
CREATE INDEX IF NOT EXISTS idx_recovery_tokens_expires ON recovery_tokens(expires_at);
