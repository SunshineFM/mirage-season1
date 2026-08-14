/**
 * Migration 016: Daily Reddit r/Coachella tips refresh — April 22, 2026
 *
 * Seeds 7 fresh tips drawn from r/Coachella and r/Stagecoach intel.
 * Current context: Coachella W2 wrapped Apr 19. Stagecoach is Apr 24–26.
 * Focus: W2 performance recaps, Stagecoach newcomer logistics, weather,
 * food strategy, attire, art gems, and GA survival hacks.
 *
 * session_id = 'REDDIT_TIP_0422' for addressable rollback.
 * tab = 'pulse' = Good Tips feed (permanent, no TTL).
 * geo_tier = 'grounds' = visible to all users.
 */
module.exports = {
  name: 'reddit_tips_refresh_apr22',
  up: async (client) => {
    const tips = [
      {
        nickname: 'WashboardRiver_53',
        text: 'First time Stagecoach this year after Coachella W1. Two things that surprised me: Ave 51 from Monroe has less of a bottleneck than Coachella traffic if you get in before noon Friday. Also the on-site Resort camping means you can actually stay for late-night sets without a 45-min parking ordeal after midnight. Same Empire Polo Club grounds — if you\'ve done Coachella you\'ll orient fast. Stagecoach energy is a lot more laid-back during the day.',
        created_at: '2026-04-21T19:00:00Z'
      },
      {
        nickname: 'SaltbrushWren_18',
        text: 'Stagecoach newbie PSA: Belt Buckle Friday is legitimately a crowd thing and people go all out. Boot Barn on Palm Canyon in Palm Springs has same-day options if you forgot real boots — do not show up in sneakers. The ground turns from grass to hard-pack dust by Saturday afternoon and your feet will pay for it. Cowboy hat isn\'t just aesthetic either; the field hits 95°F+ by 2pm and shade is scarce outside the stage canopies.',
        created_at: '2026-04-21T21:30:00Z'
      },
      {
        nickname: 'ThornbackFox_62',
        text: 'W2 Sunday recap for anyone catching the YouTube replay: Karol G closing Coachella as the first Latina headliner was a moment. She brought out Becky G and Mariah Angeliq again plus a few W2-only surprises. Watch from "Provenza" into the final closer — that 20-minute stretch was the emotional peak of the whole festival. Saturday will also go down in history: Bieber brought out Madonna who duetted on Vogue and Like a Prayer. If you missed W1 or W2, both headliner sets are fully on YouTube.',
        created_at: '2026-04-22T00:00:00Z'
      },
      {
        nickname: 'ArrowLeaf_37',
        text: 'Stagecoach weather reality check for Apr 24-26: forecast is mid-to-upper 90s Friday and Saturday, slight drop Sunday. That\'s hotter than both Coachella weekends. No shade on most of the GA field either. The misting stations near the Mane Stage are your lifeline between noon and 5pm. Key rule: electrolytes before you feel bad, not after. By the time dehydration registers you\'re already behind. Liquid IV packets or Pedialyte in your bag, not just a water bottle.',
        created_at: '2026-04-22T05:00:00Z'
      },
      {
        nickname: 'CopperRidge_91',
        text: 'Stagecoach food intel from last year: Guy Fieri\'s Smokehouse brisket is genuinely worth it but the line hits 45 min by 7pm — go at 5:30 or skip it. More importantly: walk to the back of the food court past the obvious vendors. There\'s a birria quesadilla stand near the south fence that had a 5-minute line all weekend while everything else was backed up. Post Malone closing Sunday means the grounds will be wall-to-wall — eat before 6pm or you\'re fighting crowds between songs.',
        created_at: '2026-04-22T08:30:00Z'
      },
      {
        nickname: 'KestrelBluff_25',
        text: 'Underrated W2 art gem that most people sprinted past: Sabine Marcelis\' Maze installation near the main field. Light diffusion at golden hour (5:30–6:30pm) is genuinely stunning — it\'s a desert mirage concept and the timing makes it. Also the Radiohead Bunker (Kid A / Amnesiac 25th anniversary AV experience) stayed under 10-min lines all weekend while everything else was mobbed. If either of those carry over to Stagecoach week check the grounds map when you arrive.',
        created_at: '2026-04-22T10:45:00Z'
      },
      {
        nickname: 'PaloverdeFox_44',
        text: 'GA Stagecoach tip: bring a lightweight beach chair or blanket Friday morning and stake your spot near the Mane Stage early. By 3pm it\'s shoulder-to-shoulder and claiming ground becomes a whole social negotiation. Be friendly about it though — Stagecoach crowd is genuinely more communal than Coachella, people actually share space and it comes back around. Also if you got a Rhinestone Saloon wristband for late-night sets, hit the box office first thing Friday to sort any issues before the day gets loud.',
        created_at: '2026-04-22T12:45:00Z'
      }
    ];

    for (const tip of tips) {
      await client.query(
        `INSERT INTO posts (session_id, nickname, text, tab, geo_tier, post_ip, created_at)
         VALUES ('REDDIT_TIP_0422', $1, $2, 'pulse', 'grounds', 'seed', $3)`,
        [tip.nickname, tip.text, tip.created_at]
      );
    }

    console.log(`[Migration 016] Seeded ${tips.length} tips for April 22 — W2 recaps + Stagecoach prep`);
  },
  down: async (client) => {
    const result = await client.query(
      `DELETE FROM posts WHERE session_id = 'REDDIT_TIP_0422'`
    );
    console.log(`[Migration 016 rollback] Removed ${result.rowCount} tips`);
  }
};
