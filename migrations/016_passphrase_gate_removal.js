'use strict';

module.exports = {
  name: 'passphrase_gate_removal',
  up: async (client) => {
    // Track UTM source for traffic attribution (sessions currently don't capture this)
    await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS utm_source VARCHAR(255)`);
    await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS utm_medium VARCHAR(255)`);
    await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS utm_campaign VARCHAR(255)`);
    // Tracks whether session was created before (true/default) or after (false) passphrase gate removal
    // Pre-change: true (passphrase was required to enter)
    // Post-change: false (passphrase gate removed — all new sessions are automatic)
    await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS passphrase_required BOOLEAN NOT NULL DEFAULT true`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_pr ON sessions(passphrase_required)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_utm ON sessions(utm_source) WHERE utm_source IS NOT NULL`);
  },
  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS idx_sessions_utm`);
    await client.query(`DROP INDEX IF EXISTS idx_sessions_pr`);
    await client.query(`ALTER TABLE sessions DROP COLUMN IF EXISTS passphrase_required`);
    await client.query(`ALTER TABLE sessions DROP COLUMN IF EXISTS utm_campaign`);
    await client.query(`ALTER TABLE sessions DROP COLUMN IF EXISTS utm_medium`);
    await client.query(`ALTER TABLE sessions DROP COLUMN IF EXISTS utm_source`);
  }
};