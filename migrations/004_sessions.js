module.exports = {
  name: 'sessions',
  up: async (client) => {
    // Sessions table: stores each device's geo_tier at time of onboarding
    // Used to enforce watcher (outside) tier cannot post, server-side
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id VARCHAR(64) PRIMARY KEY,
        geo_tier VARCHAR(20) NOT NULL DEFAULT 'outside',
        registered_at TIMESTAMPTZ DEFAULT NOW(),
        last_seen TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_sessions_geo ON sessions(session_id, geo_tier)');
  },
  down: async (client) => {
    await client.query('DROP TABLE IF EXISTS sessions');
  }
};
