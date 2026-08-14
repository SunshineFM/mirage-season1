module.exports = {
  name: 'admin_and_export',
  up: async (client) => {
    // Add admin_hidden column so admin can hide/restore posts independently of community flags
    await client.query(`
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS admin_hidden BOOLEAN DEFAULT FALSE
    `);

    // Data exports table — survives closure, stores pre-May-1 snapshot
    await client.query(`
      CREATE TABLE IF NOT EXISTS data_exports (
        id SERIAL PRIMARY KEY,
        export_type VARCHAR(50) NOT NULL,
        exported_at TIMESTAMPTZ DEFAULT NOW(),
        data JSONB NOT NULL
      )
    `);

    await client.query('CREATE INDEX IF NOT EXISTS idx_posts_admin_hidden ON posts(admin_hidden)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_data_exports_type ON data_exports(export_type)');
  }
};
