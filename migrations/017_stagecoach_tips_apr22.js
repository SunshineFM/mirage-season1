/**
 * Migration 017: Stagecoach 2026 tips refresh — April 22, 2026 (PM batch)
 *
 * Seeds 7 fresh Stagecoach tips drawn from current r/Stagecoach, r/Coachella,
 * official festival sources, and Desert Sun reporting.
 * Context: Stagecoach runs Apr 24–26. Festival is 2 days away.
 * Focus: cashless payments, lawn chair policy, temp swings, Palomino undercard,
 * dust prep, new Mustang Stage, shade/water strategy.
 *
 * session_id = 'STAGECOACH_0422_PM' for addressable rollback.
 * tab = 'pulse' = Good Tips feed (permanent, no TTL).
 * geo_tier = 'grounds' = visible to all users.
 */
module.exports = {
  name: 'stagecoach_tips_apr22_pm',
  up: async (client) => {
    const tips = [
      {
        nickname: 'CactusGhost_19',
        text: 'Stagecoach is fully cashless — every vendor, bar, and merch booth takes card, Apple/Google Pay, or the festival app. The reload kiosks on-site had 20–30 minute lines last year. Load your payment method now, not when you\'re standing in the sun on Friday afternoon. Also: call your bank and put a travel note on your card for Indio, CA, or it\'ll get flagged for suspicious activity by the time you\'re on your fourth round.',
        created_at: '2026-04-22T15:00:00Z'
      },
      {
        nickname: 'MesaLark_77',
        text: 'The single biggest quality-of-life advantage Stagecoach has over Coachella: you can bring a low-profile folding lawn chair into the GA field (under 9 inches off the ground — beach chair height). Stake your Mane Stage spot in the morning, drop your chair, and go eat. By 2pm the field is shoulder-to-shoulder and claiming ground becomes a whole social negotiation. Do not bring a tall camp chair — they will turn you away at the gate.',
        created_at: '2026-04-22T17:00:00Z'
      },
      {
        nickname: 'RedArroyo_51',
        text: 'Temperature reality for Apr 24–26: forecast is 95–98°F peak both Friday and Saturday, high 80s Sunday. What gets people is the swing after dark — it drops to mid-50s by 11pm. If you\'re camping and hitting Mustang Stage late sets (Diplo/Pitbull/Ludacris go until 2am), have a layer you can grab from your campsite or stash in a locker. Dusty polo field at 1am with 55°F wind is a different experience than 3pm in the sun.',
        created_at: '2026-04-22T18:30:00Z'
      },
      {
        nickname: 'SaguaroWren_21',
        text: 'The most slept-on act this year: Wyatt Flores on the Palomino Stage. He\'s on a massive streaming run and this is probably the last time you catch him in that small tent. Marcus King Band is also Palomino — those guys play like they\'re trying to win something. Get there before the set starts; Palomino fills fast once word spreads and the view evaporates if you arrive late. Check your set times app Wednesday night and plan your route.',
        created_at: '2026-04-22T19:45:00Z'
      },
      {
        nickname: 'GraniteBluff_8',
        text: 'Dust prep for Stagecoach: the camping lots funnel afternoon wind across the polo field from the south and it gets brutal by 3pm. A bandana or buff around your neck handles it. Security confiscates spray sunscreen at entry — they had a table of confiscated bottles at every gate at 2024 Stagecoach. Bring lotion only. Also protect your phone: one dust devil and your charging port will be full of debris. Zipper pocket or small bag for your phone when the wind kicks up.',
        created_at: '2026-04-22T21:00:00Z'
      },
      {
        nickname: 'PinacateFox_22',
        text: 'New for 2026: the Mustang Stage is back and it\'s the late-night hub, located near the Mane Stage entrance across from the ferris wheel. Journey and Bush play there Saturday. Hootie & the Blowfish and Third Eye Blind are Sunday. Late-night sets from Diplo, Pitbull, Ludacris after midnight. Know where it is before you need it at 11pm — the grounds get disorienting in the dark and it\'s easy to wander toward the Palomino end if you don\'t have your bearings.',
        created_at: '2026-04-22T22:00:00Z'
      },
      {
        nickname: 'ChollaHawk_34',
        text: 'Shade is almost nonexistent on the GA field 11am–4pm. Your two refuges are Diplo\'s HonkyTonk tent (air-conditioned, has line dancing, genuinely fun even between sets) and the Palomino Stage tent. Build your afternoon around acts that happen to be under a roof. Water fill stations cluster near the Mane Stage front and the food court perimeter — if you drift to the east side of the field you might not find one when you really need it. Fill every time you pass one, not just when you\'re thirsty.',
        created_at: '2026-04-22T23:00:00Z'
      }
    ];

    for (const tip of tips) {
      await client.query(
        `INSERT INTO posts (session_id, nickname, text, tab, geo_tier, post_ip, created_at)
         VALUES ('STAGECOACH_0422_PM', $1, $2, 'pulse', 'grounds', 'seed', $3)`,
        [tip.nickname, tip.text, tip.created_at]
      );
    }

    console.log(`[Migration 017] Seeded ${tips.length} Stagecoach tips for April 22 PM — cashless, chairs, temp, undercard, dust, Mustang Stage, shade`);
  },
  down: async (client) => {
    const result = await client.query(
      `DELETE FROM posts WHERE session_id = 'STAGECOACH_0422_PM'`
    );
    console.log(`[Migration 017 rollback] Removed ${result.rowCount} tips`);
  }
};
