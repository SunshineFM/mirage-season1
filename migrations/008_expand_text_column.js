module.exports = {
  name: 'expand_text_column',
  up: async (client) => {
    // Admin seeding tool allows up to 1000 chars, but posts.text was VARCHAR(280)
    // causing DB errors when admins tried to seed longer tips/content.
    // Regular user posts are still enforced at 280 chars via API validation.
    await client.query(`
      ALTER TABLE posts ALTER COLUMN text TYPE VARCHAR(1000)
    `);
  },
  down: async (client) => {
    // Note: truncates existing posts longer than 280 chars if rolled back
    await client.query(`
      ALTER TABLE posts ALTER COLUMN text TYPE VARCHAR(280)
    `);
  }
};
