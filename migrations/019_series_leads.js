module.exports = {
  name: 'series_leads',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS series_leads (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        email VARCHAR(255) NOT NULL,
        company VARCHAR(255),
        role VARCHAR(120),
        budget_tier VARCHAR(40),
        episode_interest VARCHAR(40),
        message TEXT,
        ip VARCHAR(64),
        user_agent VARCHAR(500),
        referer VARCHAR(500),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query('CREATE INDEX IF NOT EXISTS series_leads_email_idx ON series_leads (email)');
    await client.query('CREATE INDEX IF NOT EXISTS series_leads_created_at_idx ON series_leads (created_at DESC)');
  }
};
