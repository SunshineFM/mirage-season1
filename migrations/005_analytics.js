module.exports = {
  name: 'analytics',
  up: async (client) => {
    // Page views table: tracks every device visit for unique-device analytics
    await client.query(`
      CREATE TABLE IF NOT EXISTS page_views (
        id BIGSERIAL PRIMARY KEY,
        device_id VARCHAR(64) NOT NULL,
        path VARCHAR(255) NOT NULL DEFAULT '/app',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_pv_device ON page_views(device_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_pv_created ON page_views(created_at)');
    // Add expires_at to posts for pulse log tracking (won't be deleted anymore)
    // pulse posts stay in DB; live feed still filters created_at < 30 min ago
    // NOTE: we stop deleting pulse posts so the pulse log works
  },
  down: async (client) => {
    await client.query('DROP TABLE IF EXISTS page_views');
  }
};
