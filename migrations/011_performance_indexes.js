/**
 * Migration 011: Performance indexes for W1 load readiness
 *
 * 1. reactions(post_id, emoji) — main feed subquery groups reactions per post by emoji.
 *    Existing idx_reactions_post covers post_id alone; composite index lets Postgres
 *    satisfy GROUP BY (emoji) directly from the index, avoiding a heap scan + sort.
 *
 * 2. posts(flag_count, admin_hidden, created_at) partial index — moderation queries
 *    filter WHERE flag_count >= 3 OR admin_hidden = TRUE. Partial index keeps it tiny
 *    (< 1% of rows) while covering all admin moderation lookups.
 */
module.exports = {
  name: 'performance_indexes',
  up: async (client) => {
    // Composite index for per-post emoji reaction aggregation in feed queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reactions_post_emoji
      ON reactions (post_id, emoji)
    `);

    // Partial index covering only moderation-relevant posts (flagged or admin-hidden)
    // Keeps index footprint minimal while speeding up admin dashboard queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_posts_moderation_state
      ON posts (flag_count, admin_hidden, created_at DESC)
      WHERE flag_count >= 3 OR admin_hidden = TRUE
    `);
  },
  down: async (client) => {
    await client.query('DROP INDEX IF EXISTS idx_reactions_post_emoji');
    await client.query('DROP INDEX IF EXISTS idx_posts_moderation_state');
  }
};
