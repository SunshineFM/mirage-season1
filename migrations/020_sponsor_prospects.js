// TODO(owner): Replace brand entries below with the final 10–15 brands from the
// vertical video pilot prospect research. Every column below maps 1:1 to the
// sponsor_prospects table; contact_email and source_link are the two columns
// most likely to be empty until the research lands.
const BRANDS = [
  {
    brand_name: '[Brand 1 – fill from sponsor prospect research]',
    category: null,
    rationale: null,
    contact_name: null,
    contact_email: null,
    outreach_status: 'not_contacted',
    notes: null,
    source_link: null
  },
  {
    brand_name: '[Brand 2 – fill from sponsor prospect research]',
    category: null,
    rationale: null,
    contact_name: null,
    contact_email: null,
    outreach_status: 'not_contacted',
    notes: null,
    source_link: null
  },
  {
    brand_name: '[Brand 3 – fill from sponsor prospect research]',
    category: null,
    rationale: null,
    contact_name: null,
    contact_email: null,
    outreach_status: 'not_contacted',
    notes: null,
    source_link: null
  },
  {
    brand_name: '[Brand 4 – fill from sponsor prospect research]',
    category: null,
    rationale: null,
    contact_name: null,
    contact_email: null,
    outreach_status: 'not_contacted',
    notes: null,
    source_link: null
  },
  {
    brand_name: '[Brand 5 – fill from sponsor prospect research]',
    category: null,
    rationale: null,
    contact_name: null,
    contact_email: null,
    outreach_status: 'not_contacted',
    notes: null,
    source_link: null
  },
  {
    brand_name: '[Brand 6 – fill from sponsor prospect research]',
    category: null,
    rationale: null,
    contact_name: null,
    contact_email: null,
    outreach_status: 'not_contacted',
    notes: null,
    source_link: null
  },
  {
    brand_name: '[Brand 7 – fill from sponsor prospect research]',
    category: null,
    rationale: null,
    contact_name: null,
    contact_email: null,
    outreach_status: 'not_contacted',
    notes: null,
    source_link: null
  },
  {
    brand_name: '[Brand 8 – fill from sponsor prospect research]',
    category: null,
    rationale: null,
    contact_name: null,
    contact_email: null,
    outreach_status: 'not_contacted',
    notes: null,
    source_link: null
  },
  {
    brand_name: '[Brand 9 – fill from sponsor prospect research]',
    category: null,
    rationale: null,
    contact_name: null,
    contact_email: null,
    outreach_status: 'not_contacted',
    notes: null,
    source_link: null
  },
  {
    brand_name: '[Brand 10 – fill from sponsor prospect research]',
    category: null,
    rationale: null,
    contact_name: null,
    contact_email: null,
    outreach_status: 'not_contacted',
    notes: null,
    source_link: null
  },
  {
    brand_name: '[Brand 11 – fill from sponsor prospect research]',
    category: null,
    rationale: null,
    contact_name: null,
    contact_email: null,
    outreach_status: 'not_contacted',
    notes: null,
    source_link: null
  },
  {
    brand_name: '[Brand 12 – fill from sponsor prospect research]',
    category: null,
    rationale: null,
    contact_name: null,
    contact_email: null,
    outreach_status: 'not_contacted',
    notes: null,
    source_link: null
  }
];

module.exports = {
  name: 'sponsor_prospects',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS sponsor_prospects (
        id              SERIAL PRIMARY KEY,
        brand_name      VARCHAR(255) NOT NULL,
        category        VARCHAR(120),
        rationale       TEXT,
        contact_name    VARCHAR(255),
        contact_email   VARCHAR(255),
        outreach_status VARCHAR(20) NOT NULL DEFAULT 'not_contacted',
        notes           TEXT,
        source_link     VARCHAR(500),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS sponsor_prospects_brand_name_idx ON sponsor_prospects (LOWER(brand_name))');
    await client.query('CREATE INDEX IF NOT EXISTS sponsor_prospects_status_idx     ON sponsor_prospects (outreach_status)');
    await client.query('CREATE INDEX IF NOT EXISTS sponsor_prospects_created_at_idx ON sponsor_prospects (created_at DESC)');

    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sponsor_prospects_outreach_status_check') THEN
          ALTER TABLE sponsor_prospects
            ADD CONSTRAINT sponsor_prospects_outreach_status_check
            CHECK (outreach_status IN ('not_contacted', 'pitched', 'follow_up', 'closed'));
        END IF;
      END $$;
    `);

    for (const b of BRANDS) {
      await client.query(
        `INSERT INTO sponsor_prospects
           (brand_name, category, rationale, contact_name, contact_email, outreach_status, notes, source_link)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (LOWER(brand_name))
         DO NOTHING`,
        [
          b.brand_name,
          b.category ?? null,
          b.rationale ?? null,
          b.contact_name ?? null,
          b.contact_email ?? null,
          b.outreach_status || 'not_contacted',
          b.notes ?? null,
          b.source_link ?? null
        ]
      );
    }
  }
};
