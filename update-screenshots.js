const fs = require('fs');
let content = fs.readFileSync('public/season1.html', 'utf8');

// Replace bottom row screenshots (positions 5-8 in the grid)
// These are currently: 01-landing-hero-wide, 06-farewell, 02-app-feed, 03-tips-feed
// Replace with: feed-01-good-shots, feed-02-good-vibes, feed-03-good-tips, feed-04-hey-mirage

const replacements = [
  {
    old: `        <div class=\"screenshot-card\" onclick=\"openLightbox('/archive/screenshots/01-landing-hero-wide.png')\">
          <div class=\"screenshot-img-wrap\">
            <img src=\"/archive/screenshots/01-landing-hero-wide.png\" alt=\"Full landing page view\" loading=\"lazy\">
          </div>
          <div class=\"screenshot-caption\">Full View</div>
        </div>`,
    new: `        <div class=\"screenshot-card\" onclick=\"openLightbox('/archive/screenshots/feed-01-good-shots.svg')\">
          <div class=\"screenshot-img-wrap\">
            <img src=\"/archive/screenshots/feed-01-good-shots.svg\" alt=\"Good Shots feed — photo posts from the fest\" loading=\"lazy\">
          </div>
          <div class=\"screenshot-caption\">Good Shots</div>
        </div>`
  },
  {
    old: `        <div class=\"screenshot-card\" onclick=\"openLightbox('/archive/screenshots/06-farewell.png')\">
          <div class=\"screenshot-img-wrap\">
            <img src=\"/archive/screenshots/06-farewell.png\" alt=\"Farewell page\" loading=\"lazy\">
          </div>
          <div class=\"screenshot-caption\">Farewell</div>
        </div>`,
    new: `        <div class=\"screenshot-card\" onclick=\"openLightbox('/archive/screenshots/feed-02-good-vibes.svg')\">
          <div class=\"screenshot-img-wrap\">
            <img src=\"/archive/screenshots/feed-02-good-vibes.svg\" alt=\"Good Vibes feed — kind words and positive energy\" loading=\"lazy\">
          </div>
          <div class=\"screenshot-caption\">Good Vibes</div>
        </div>`
  },
  {
    old: `        <div class=\"screenshot-card\" onclick=\"openLightbox('/archive/screenshots/02-app-feed.png')\">
          <div class=\"screenshot-img-wrap\">
            <img src=\"/archive/screenshots/02-app-feed.png\" alt=\"Feed with geo-gated posts\" loading=\"lazy\">
          </div>
          <div class=\"screenshot-caption\">Geo-Gate</div>
        </div>`,
    new: `        <div class=\"screenshot-card\" onclick=\"openLightbox('/archive/screenshots/feed-03-good-tips.svg')\">
          <div class=\"screenshot-img-wrap\">
            <img src=\"/archive/screenshots/feed-03-good-tips.svg\" alt=\"Good Tips feed — festival info and tips\" loading=\"lazy\">
          </div>
          <div class=\"screenshot-caption\">Good Tips</div>
        </div>`
  },
  {
    old: `        <div class=\"screenshot-card\" onclick=\"openLightbox('/archive/screenshots/03-tips-feed.png')\">
          <div class=\"screenshot-img-wrap\">
            <img src=\"/archive/screenshots/03-tips-feed.png\" alt=\"Community tips\" loading=\"lazy\">
          </div>
          <div class=\"screenshot-caption\">Community</div>
        </div>`,
    new: `        <div class=\"screenshot-card\" onclick=\"openLightbox('/archive/screenshots/feed-04-hey-mirage.svg')\">
          <div class=\"screenshot-img-wrap\">
            <img src=\"/archive/screenshots/feed-04-hey-mirage.svg\" alt=\"Hey Mirage — private feedback to the team\" loading=\"lazy\">
          </div>
          <div class=\"screenshot-caption\">Hey Mirage</div>
        </div>`
  }
];

let count = 0;
for (const r of replacements) {
  if (content.includes(r.old)) {
    content = content.replace(r.old, r.new);
    count++;
    console.log(`Replaced: ${r.old.substring(30, 60)}...`);
  } else {
    console.log('NOT FOUND: ' + r.old.substring(0, 80));
  }
}

fs.writeFileSync('public/season1.html', content);
console.log(`\nDone. ${count}/${replacements.length} replacements made.`);