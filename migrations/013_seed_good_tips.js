/**
 * Migration 013: Seed Good Tips feed with curated Coachella tips
 *
 * Inserts 18 authentic festival tips from "community members" with
 * staggered timestamps (last ~40 hours) so the feed feels alive
 * when real attendees arrive on W1 Day 1 (April 10).
 *
 * session_id = 'SEED_TIP' makes them identifiable for cleanup.
 * tab = 'pulse' = Good Tips feed.
 * geo_tier = 'grounds' = visible to all users.
 */
module.exports = {
  name: 'seed_good_tips',
  up: async (client) => {
    const tips = [
      {
        nickname: 'DustyCoyote42',
        text: 'Freeze a gallon jug of water the night before. By 2pm it\'s the perfect temperature and you\'ve got cold water when everyone else is drinking warm Dasani. Game changer.',
        created_at: '2026-04-08T01:15:00Z'
      },
      {
        nickname: 'SunbakedLizard17',
        text: 'The paella inside the festival is actually incredible. Yes the line looks insane but it moves fast. Worth every minute of the wait — I go back every year.',
        created_at: '2026-04-08T03:42:00Z'
      },
      {
        nickname: 'GoldenMesa88',
        text: 'If you\'re driving, leave by 2pm at the latest for a good spot. After 3pm you\'re sitting in a line on Monroe for an hour easy. The earlier the better honestly.',
        created_at: '2026-04-08T05:20:00Z'
      },
      {
        nickname: 'ParchedHawk03',
        text: 'First timer mistake: wearing brand new shoes. Break them in for at least a week before. Your feet will be doing 20k+ steps a day on uneven ground — don\'t learn this the hard way.',
        created_at: '2026-04-08T07:55:00Z'
      },
      {
        nickname: 'ShimmeringOasis71',
        text: 'The Do LaB is where the real magic happens. Friday and Saturday late night sets go until like 2am and it\'s a whole different vibe from the main stages. Don\'t sleep on it.',
        created_at: '2026-04-08T09:10:00Z'
      },
      {
        nickname: 'AridRattler55',
        text: 'Bring a portable charger that can do at least 3 full charges. Your phone WILL die by 5pm if you\'re taking photos and using the app all day. The charging stations have hour-long waits.',
        created_at: '2026-04-08T11:33:00Z'
      },
      {
        nickname: 'WindsweptCanyon29',
        text: 'Just a heads up — food outside the festival grounds is NOT a quick walk. You\'re looking at 30 min on foot or an hour+ driving with traffic. Plan to eat inside or bring snacks for the lot.',
        created_at: '2026-04-08T13:05:00Z'
      },
      {
        nickname: 'RustySage44',
        text: 'Shuttle passes are worth it if you\'re staying in Palm Springs or La Quinta. Zero parking stress and you can pregame on the bus. Just don\'t miss the last one back lol.',
        created_at: '2026-04-08T14:48:00Z'
      },
      {
        nickname: 'FadedJoshua92',
        text: 'Nobody tells you about the dust. Like, REAL dust. Bring a bandana or buff for your face and a gallon ziploc for your phone when the wind picks up around 4-5pm. It\'s no joke.',
        created_at: '2026-04-08T17:22:00Z'
      },
      {
        nickname: 'BurntBobcat36',
        text: 'Go see at least one artist you\'ve never heard of. Some of my best Coachella memories are stumbling into a random Sonora tent set. That\'s how I found half my current playlist.',
        created_at: '2026-04-08T19:00:00Z'
      },
      {
        nickname: 'CopperGecko63',
        text: 'Baby wipes. Bring a whole pack. There\'s no running water at the portapotties and hand sanitizer only does so much. You\'ll thank me by day 2.',
        created_at: '2026-04-08T21:37:00Z'
      },
      {
        nickname: 'CrimsonQuail08',
        text: 'Spicy Pie is a Coachella institution but honestly try the garlic knots too. And the truffle fries from one of the craft food stands near Gobi are lowkey the best thing there.',
        created_at: '2026-04-08T23:15:00Z'
      },
      {
        nickname: 'AmberFox51',
        text: 'Lockers are absolutely worth the money. Stash your merch, extra water, sunscreen — whatever. Running back to the car isn\'t an option once you\'re in. It\'s a 20+ min walk each way to the lot.',
        created_at: '2026-04-09T01:40:00Z'
      },
      {
        nickname: 'TawnyViper19',
        text: 'Don\'t try to see every headliner from the front. Sound at the back of the main stage is actually better and you can breathe. The pit is for people who got there 3 hours early.',
        created_at: '2026-04-09T04:05:00Z'
      },
      {
        nickname: 'MirageRoadrunner77',
        text: 'The art installations are 10x better at night. Spectra tower and the big sculptures completely transform after sunset. Set aside an hour to just walk the grounds after dark — trust me.',
        created_at: '2026-04-09T07:28:00Z'
      },
      {
        nickname: 'ScorchedTortoise84',
        text: 'Electrolytes > plain water. Bring Liquid IV or Pedialyte packets. You\'re sweating all day in 90+ degree heat and plain water won\'t keep you going. I bonked hard on day 2 my first year without them.',
        created_at: '2026-04-09T09:52:00Z'
      },
      {
        nickname: 'SandyJackrabbit60',
        text: 'The açaí bowls near the Gobi tent are genuinely good and actually fill you up. Like $14 but way better than another $8 lemonade that\'s gone in 2 minutes.',
        created_at: '2026-04-09T12:15:00Z'
      },
      {
        nickname: 'BlazeHornet23',
        text: 'Set a meeting point with your group for when service drops. Cell towers get absolutely hammered during headliners. We always do the big LOVE sign — easy to find and well lit at night.',
        created_at: '2026-04-09T15:33:00Z'
      }
    ];

    for (const tip of tips) {
      await client.query(
        `INSERT INTO posts (session_id, nickname, text, tab, geo_tier, post_ip, created_at)
         VALUES ('SEED_TIP', $1, $2, 'pulse', 'grounds', 'seed', $3)`,
        [tip.nickname, tip.text, tip.created_at]
      );
    }

    console.log(`[Migration 013] Seeded ${tips.length} Good Tips posts`);
  },
  down: async (client) => {
    const result = await client.query(
      `DELETE FROM posts WHERE session_id = 'SEED_TIP'`
    );
    console.log(`[Migration 013 rollback] Removed ${result.rowCount} seeded tips`);
  }
};
