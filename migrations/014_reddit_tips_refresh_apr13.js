/**
 * Migration 014: Daily Reddit r/Coachella tips refresh — April 13, 2026
 *
 * Seeds 8 authentic tips pulled from W1 weekend intel (April 11-13).
 * Covers: W1 lessons learned, W2 prep, Stagecoach tips.
 * session_id = 'REDDIT_TIP_0413' so these are separately addressable from
 * the original SEED_TIP batch.
 * tab = 'pulse' = Good Tips feed.
 * geo_tier = 'grounds' = visible to all users.
 */
module.exports = {
  name: 'reddit_tips_refresh_apr13',
  up: async (client) => {
    const tips = [
      {
        nickname: 'DustyHawk_42',
        text: 'W2 people — the wind W1 was no joke. Anyma literally got weather-canceled Friday midnight because the gusts were so bad. Pack a bandana or buff, check the forecast obsessively starting Tuesday, and bring a light layer for after 9pm. The desert gets cold fast once the sun\'s gone.',
        created_at: '2026-04-12T22:15:00Z'
      },
      {
        nickname: 'SandOwl_7',
        text: 'If you\'re going W2 — do NOT sleep on Karol G\'s Sunday set. She just made history as the first Latina to headline Coachella and the field energy was on another level. Get into position before 9pm. Don\'t make the mistake of wandering Sahara and catching it on the stream later.',
        created_at: '2026-04-13T01:30:00Z'
      },
      {
        nickname: 'TumbleweedRex_19',
        text: 'Food line tip from W1: stalls near Mojave were 20-30 min deep between 1-3pm and again 6-8pm. Dead simple fix — eat at noon before everything fills, or grab something at 4pm in the gap. You will not regret it. Cold noodles at the bao stand are criminally underrated too.',
        created_at: '2026-04-13T04:45:00Z'
      },
      {
        nickname: 'CactusWren_88',
        text: 'Monroe and Ave 52 were a complete standstill Friday afternoon around 2pm. W2 lesson: either arrive before noon to beat the rush, OR wait until 3:30+ and come in through the south lot entrance — way less backed up. The shuttle from Palm Springs Convention Center is still the move if you want zero stress.',
        created_at: '2026-04-13T07:20:00Z'
      },
      {
        nickname: 'SagebrushKid_03',
        text: 'Hidden gem nobody is talking about: the Radiohead Bunker installation. New space they built just for the 25th anniversary of Kid A and Amnesiac — audiovisual, fully immersive, not rushed. Lines were basically nothing W1 because people didn\'t know it existed. Go at 2pm before the crowds wake up.',
        created_at: '2026-04-13T10:00:00Z'
      },
      {
        nickname: 'DuneSparrow_66',
        text: 'Keep this in mind for W2: Anyma was supposed to close Friday night with a midnight set and it was canceled due to weather. If conditions cooperate next weekend, that midnight Coachella Stage slot could be the best set of the festival. Stay late Friday. Don\'t assume it\'ll get canceled again.',
        created_at: '2026-04-13T13:30:00Z'
      },
      {
        nickname: 'DesertFoxPaw_51',
        text: 'Stagecoach crew — Belt Buckle Friday (April 24) is a real tradition. Wear the biggest, most ridiculous western belt buckle you own. First-timers who don\'t know look confused and then immediately jealous. Also Guy Fieri\'s Smokehouse on-site is legit brisket. Not a joke, actually go.',
        created_at: '2026-04-13T16:45:00Z'
      },
      {
        nickname: 'MojaveJack_24',
        text: 'Stagecoach campers: they clean the grounds overnight so you CANNOT leave your chair to hold a spot. Bring a lightweight packable chair — you\'ll be carrying it all three days. Also huge news this year: the Mustang Stage is back for the first time since 2017. Three stages now means way better crowd spread. Use it.',
        created_at: '2026-04-13T20:30:00Z'
      }
    ];

    for (const tip of tips) {
      await client.query(
        `INSERT INTO posts (session_id, nickname, text, tab, geo_tier, post_ip, created_at)
         VALUES ('REDDIT_TIP_0413', $1, $2, 'pulse', 'grounds', 'seed', $3)`,
        [tip.nickname, tip.text, tip.created_at]
      );
    }

    console.log(`[Migration 014] Seeded ${tips.length} Reddit refresh tips for April 13`);
  },
  down: async (client) => {
    const result = await client.query(
      `DELETE FROM posts WHERE session_id = 'REDDIT_TIP_0413'`
    );
    console.log(`[Migration 014 rollback] Removed ${result.rowCount} Reddit refresh tips`);
  }
};
