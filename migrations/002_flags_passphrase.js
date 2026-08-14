module.exports = {
  name: 'flags_passphrase',
  up: async (client) => {
    // Add flag_count to posts
    await client.query(`
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS flag_count INTEGER DEFAULT 0
    `);

    // post_flags: tracks which sessions flagged which posts (prevents double-flagging)
    await client.query(`
      CREATE TABLE IF NOT EXISTS post_flags (
        id SERIAL PRIMARY KEY,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        session_id VARCHAR(64) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(post_id, session_id)
      )
    `);

    // passphrase_overrides: admin can set the daily word for any day
    await client.query(`
      CREATE TABLE IF NOT EXISTS passphrase_overrides (
        id SERIAL PRIMARY KEY,
        date DATE NOT NULL UNIQUE,
        word VARCHAR(100) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query('CREATE INDEX IF NOT EXISTS idx_post_flags_post ON post_flags(post_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_passphrase_date ON passphrase_overrides(date)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_posts_tab_flag ON posts(tab, flagged, flag_count)');
  }
};
