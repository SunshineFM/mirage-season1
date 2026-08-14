/**
 * Migration 010: Add pin_order column to posts for ordered multi-pin support.
 *
 * - pin_order NULL  → not pinned
 * - pin_order 1, 2, 3... → pinned; lower number = higher on feed
 * - Per-tab ordering: pin_order is scoped to (tab, pin_order) pairs
 * - admin_pinned kept for backward compat; always updated in sync
 */
module.exports = {
  name: '010_pin_order',
  up: async (client) => {
    await client.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS pin_order INTEGER DEFAULT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS posts_tab_pin_order_idx ON posts (tab, pin_order)`);
  }
};
