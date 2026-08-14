module.exports = {
  name: 'admin_pinned',
  up: async (client) => {
    // Add admin_pinned column to posts — allows admin to pin a post to the top of Good Vibes
    await client.query(`
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS admin_pinned BOOLEAN DEFAULT FALSE
    `);
  },
  down: async (client) => {
    await client.query(`
      ALTER TABLE posts DROP COLUMN IF EXISTS admin_pinned
    `);
  }
};
