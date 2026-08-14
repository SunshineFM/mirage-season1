module.exports = {
  name: 'create_posts_reactions',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(64) NOT NULL,
        nickname VARCHAR(30) NOT NULL,
        text VARCHAR(280) NOT NULL,
        tab VARCHAR(20) NOT NULL,
        photo_url TEXT,
        geo_tier VARCHAR(20) NOT NULL,
        latitude DECIMAL(10, 7),
        longitude DECIMAL(10, 7),
        flagged BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS reactions (
        id SERIAL PRIMARY KEY,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        session_id VARCHAR(64) NOT NULL,
        emoji VARCHAR(10) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(post_id, session_id, emoji)
      )
    `);

    await client.query('CREATE INDEX IF NOT EXISTS idx_posts_tab_created ON posts(tab, created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_posts_flagged ON posts(flagged)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_posts_session ON posts(session_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(post_id)');
  }
};
