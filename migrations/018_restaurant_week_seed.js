/**
 * Migration 018: Restaurant Week microsite — seed 126 DineGPS rows.
 *
 * Creates the `restaurants` table and seeds it from data/restaurants.json
 * (126 rows). Follows the safe-deployed-on-every-build pattern:
 *   - CREATE TABLE / CREATE INDEX use IF NOT EXISTS
 *   - row insert uses ON CONFLICT (slug) DO NOTHING for idempotent re-runs
 *   - dataset is read from disk relative to this file (no runtime fetch)
 *   - throws loudly if dataset shape is wrong so a bad ingest can't ship silently
 *
 * This migration is structural for the /eat microsite (see server.js) and is
 * unrelated to the Mirage Season 1 posts/reactions schema.
 */
const fs = require('fs');
const path = require('path');

const DATASET_PATH = path.join(__dirname, '..', 'data', 'restaurants.json');
const EXPECTED_ROW_COUNT = 126;

module.exports = {
  name: 'restaurant_week_seed',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS restaurants (
        id SERIAL PRIMARY KEY,
        slug VARCHAR(120) UNIQUE NOT NULL,
        name VARCHAR(160) NOT NULL,
        street VARCHAR(200),
        city VARCHAR(60) NOT NULL,
        neighborhood VARCHAR(120),
        cuisine VARCHAR(60) NOT NULL,
        price_point VARCHAR(8) NOT NULL,
        phone VARCHAR(40),
        website_url TEXT,
        reservation_url TEXT,
        latitude NUMERIC(9,6),
        longitude NUMERIC(9,6),
        offer_title VARCHAR(200),
        offer_text TEXT,
        offer_valid_dates VARCHAR(120),
        source_id VARCHAR(40),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS restaurants_city_idx ON restaurants (city)`);
    await client.query(`CREATE INDEX IF NOT EXISTS restaurants_cuisine_idx ON restaurants (cuisine)`);
    await client.query(`CREATE INDEX IF NOT EXISTS restaurants_price_idx ON restaurants (price_point)`);

    if (!fs.existsSync(DATASET_PATH)) {
      throw new Error(`Migration 018 failed: dataset not found at ${DATASET_PATH}`);
    }

    const raw = fs.readFileSync(DATASET_PATH, 'utf8');
    let rows;
    try {
      rows = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Migration 018 failed: dataset is not valid JSON — ${err.message}`);
    }

    if (!Array.isArray(rows)) {
      throw new Error(`Migration 018 failed: dataset must be a JSON array`);
    }
    if (rows.length !== EXPECTED_ROW_COUNT) {
      throw new Error(`Migration 018 failed: expected ${EXPECTED_ROW_COUNT} rows, got ${rows.length}`);
    }

    let inserted = 0;
    for (const r of rows) {
      const result = await client.query(
        `INSERT INTO restaurants
           (slug, name, street, city, neighborhood, cuisine, price_point,
            phone, website_url, reservation_url, latitude, longitude,
            offer_title, offer_text, offer_valid_dates, source_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (slug) DO NOTHING`,
        [
          r.slug, r.name, r.street ?? null, r.city, r.neighborhood ?? null,
          r.cuisine, r.price_point, r.phone ?? null, r.website_url ?? null,
          r.reservation_url ?? null, r.latitude ?? null, r.longitude ?? null,
          r.offer_title ?? null, r.offer_text ?? null,
          r.offer_valid_dates ?? null, r.source_id ?? null
        ]
      );
      inserted += result.rowCount || 0;
    }

    console.log(`[Migration 018] Seeded ${inserted}/${rows.length} restaurants from data/restaurants.json`);
  },
  down: async (client) => {
    const result = await client.query(
      `DELETE FROM restaurants WHERE source_id IS NOT NULL`
    );
    console.log(`[Migration 018 rollback] Removed ${result.rowCount} seeded rows`);
  }
};
