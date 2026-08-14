const fs = require('fs');
let content = fs.readFileSync('public/season1.html', 'utf8');

const oldBlock = `<div class=\"asset-video-wrap\">
            <video class=\"asset-video\" controls playsinline preload=\"metadata\">
              <source src=\"/archive/ads/coachella-ad.mp4\" type=\"video/mp4\">
              Your browser does not support the video tag.
            </video>
          </div>`;

const newBlock = `<div class=\"asset-video-wrap\" style=\"aspect-ratio:9/16;width:100%;max-width:300px;min-height:534px;\">
            <iframe
              src=\"https://www.youtube.com/embed/QpQIf8VFc0o\"
              title=\"Mirage — Season 1 Ad (Coachella 2026)\"
              frameborder=\"0\"
              allow=\"accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture\"
              allowfullscreen
              style=\"aspect-ratio:9/16;width:100%;height:100%;display:block;\"
            ></iframe>
          </div>`;

if (content.includes(oldBlock)) {
  content = content.replace(oldBlock, newBlock);
  fs.writeFileSync('public/season1.html', content);
  console.log('SUCCESS: replaced video with YouTube iframe');
} else {
  console.log('ERROR: block not found. Showing lines 1427-1438:');
  const lines = content.split('\n');
  for (let i = 1425; i < 1438; i++) {
    console.log(i + ': ' + JSON.stringify(lines[i]));
  }
}