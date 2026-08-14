module.exports = {
  name: 'notes_to_sat',
  up: async (client) => {
    // Notes to Sat: private messages from users to Sat (admin-only visible)
    await client.query(`
      CREATE TABLE IF NOT EXISTS notes_to_sat (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(64) NOT NULL,
        nickname VARCHAR(30) NOT NULL DEFAULT 'anonymous',
        text TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query('CREATE INDEX IF NOT EXISTS idx_notes_to_sat_created ON notes_to_sat(created_at DESC)');
  }
};
