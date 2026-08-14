module.exports = {
  name: 'moderation_v2',
  up: async (client) => {
    // Add flagged_ip to post_flags for distinct-IP flag counting
    await client.query(`
      ALTER TABLE post_flags ADD COLUMN IF NOT EXISTS flagged_ip VARCHAR(64) DEFAULT 'unknown'
    `);

    // Add post_ip to posts so admins can block the poster's IP from the admin panel
    await client.query(`
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS post_ip VARCHAR(64) DEFAULT 'unknown'
    `);

    // IP blocks table — admin can block an IP for 24 hours (or longer)
    await client.query(`
      CREATE TABLE IF NOT EXISTS ip_blocks (
        id SERIAL PRIMARY KEY,
        ip VARCHAR(64) NOT NULL UNIQUE,
        blocked_until TIMESTAMPTZ NOT NULL,
        blocked_by VARCHAR(32) DEFAULT 'admin',
        reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Indexes for fast lookups
    await client.query('CREATE INDEX IF NOT EXISTS idx_post_flags_post_created ON post_flags(post_id, created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_post_flags_post_ip ON post_flags(post_id, flagged_ip)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_ip_blocks_ip ON ip_blocks(ip)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_ip_blocks_until ON ip_blocks(blocked_until)');

    // Admin hidden posts should be queryable fast
    await client.query('CREATE INDEX IF NOT EXISTS idx_posts_admin_hidden ON posts(admin_hidden, created_at DESC)');
  },
  down: async (client) => {
    await client.query('DROP TABLE IF EXISTS ip_blocks');
    await client.query('DROP INDEX IF EXISTS idx_post_flags_post_created');
    await client.query('DROP INDEX IF EXISTS idx_post_flags_post_ip');
    await client.query('DROP INDEX IF EXISTS idx_ip_blocks_ip');
    await client.query('DROP INDEX IF EXISTS idx_ip_blocks_until');
    await client.query('DROP INDEX IF EXISTS idx_posts_admin_hidden');
    // Note: cannot easily remove column flagged_ip — leaving in place on rollback
  }
};
