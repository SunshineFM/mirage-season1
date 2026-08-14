/**
 * Migration 015: W2 Weekend tips refresh — April 14, 2026
 *
 * Seeds 8 fresh W2-specific tips drawn from r/Coachella W1 recap threads.
 * Covers: W1 crowd density lessons, weather watch, logistics, lineup intel,
 * and the specific vibe shift when the W2 crowd arrives.
 *
 * session_id = 'W2_TIP_0414' so these are separately addressable for future refreshes.
 * tab = 'pulse' = Good Tips feed.
 * geo_tier = 'grounds' = visible to all users.
 */
module.exports = {
  name: 'w2_tips_refresh_apr14',
  up: async (client) => {
    const tips = [
      {
        nickname: 'RoadrunnerDust_77',
        text: 'W2 heads — the Anyma cancellation means Friday night is WIDE open now. That midnight Coachella Stage slot is almost certainly getting filled with something massive. Check the app Friday morning for updates. The replacement set could be the weekend\'s best-kept secret if you\'re in the know.',
        created_at: '2026-04-14T08:00:00Z'
      },
      {
        nickname: 'CanyonWren_44',
        text: 'W1 lesson: the Sahara tent gets absolutely packed between 7-9pm no matter who\'s playing. If you want to actually see the main stage headliner from somewhere decent, you need to start drifting back by 8:15. The 9pm set start time is real — they don\'t wait for stragglers.',
        created_at: '2026-04-14T09:30:00Z'
      },
      {
        nickname: 'SageOwl_91',
        text: 'Temperature swing alert: W1 nights got into the mid-50s after midnight. Bring a real layer, not just a hoodie. The desert does not care that you\'re dancing. Especially if you\'re camping — the temperature drop is sudden and it hits hard around 1am.',
        created_at: '2026-04-14T11:00:00Z'
      },
      {
        nickname: 'DustdevilKid_33',
        text: 'Hot take from W1 that I stand by for W2: arrive through the south lot if you\'re coming in after noon. Monroe and Ave 52 back up past the highway onramps and it doesn\'t clear until 3:30-4pm. South entrance was consistently faster all weekend. Bookmark this one.',
        created_at: '2026-04-14T12:30:00Z'
      },
      {
        nickname: 'BajadaFox_58',
        text: 'The food strategy that saved my W1: hit the paella stand right when it opens at noon — line is 10 minutes, not 40. By 2pm that same stand is 35 minutes deep. Dead simple timing hack that nobody talks about. The garlic knots are also worth a second trip.',
        created_at: '2026-04-14T14:00:00Z'
      },
      {
        nickname: 'WindSparrow_12',
        text: 'W2 is a different energy than W1. W1 was the rehearsal crowd — people who flew in early, camped all three days, already know the layout. The W2 crowd fills in starting Thursday night and by Friday afternoon the vibe is completely different. If you want the intimate experience, go early. Once Friday evening hits, it\'s a different festival.',
        created_at: '2026-04-14T15:30:00Z'
      },
      {
        nickname: 'MirageHawk_65',
        text: 'New hidden gem for W2: the Radiohead Bunker installation. Built for the Kid A / Amnesiac 25th anniversary, fully immersive audiovisual, basically nobody knew it existed during W1. Lines stayed under 10 minutes all weekend. Go around 2pm when the sun is highest — the contrast with the dark interior is part of the experience.',
        created_at: '2026-04-14T17:00:00Z'
      },
      {
        nickname: 'AridLizard_80',
        text: 'Electrolytes tip nobody asked for but you need it: Liquid IV or Pedialyte packets are the move, not plain water. You\'re sweating constantly in 85-90°F and plain water will leave you dragging by 4pm. I watched three people in my camp get pulled by medical on W1 Saturday from plain-water dehydration. This is preventable.',
        created_at: '2026-04-14T18:30:00Z'
      }
    ];

    for (const tip of tips) {
      await client.query(
        `INSERT INTO posts (session_id, nickname, text, tab, geo_tier, post_ip, created_at)
         VALUES ('W2_TIP_0414', $1, $2, 'pulse', 'grounds', 'seed', $3)`,
        [tip.nickname, tip.text, tip.created_at]
      );
    }

    console.log(`[Migration 015] Seeded ${tips.length} W2 tips for April 14`);
  },
  down: async (client) => {
    const result = await client.query(
      `DELETE FROM posts WHERE session_id = 'W2_TIP_0414'`
    );
    console.log(`[Migration 015 rollback] Removed ${result.rowCount} W2 tips`);
  }
};