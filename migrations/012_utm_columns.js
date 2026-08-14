module.exports = {
  name: 'utm_columns',
  up: async (client) => {
    // Add UTM attribution columns to page_views for Meta Ads campaign tracking
    await client.query(`ALTER TABLE page_views ADD COLUMN IF NOT EXISTS utm_source VARCHAR(255)`);
    await client.query(`ALTER TABLE page_views ADD COLUMN IF NOT EXISTS utm_medium VARCHAR(255)`);
    await client.query(`ALTER TABLE page_views ADD COLUMN IF NOT EXISTS utm_campaign VARCHAR(255)`);
    // Index for filtering by source (most common attribution query)
    await client.query('CREATE INDEX IF NOT EXISTS idx_pv_utm_source ON page_views(utm_source) WHERE utm_source IS NOT NULL');
  },
  down: async (client) => {
    await client.query('ALTER TABLE page_views DROP COLUMN IF EXISTS utm_campaign');
    await client.query('ALTER TABLE page_views DROP COLUMN IF EXISTS utm_medium');
    await client.query('ALTER TABLE page_views DROP COLUMN IF EXISTS utm_source');
  }
};
