const https = require('https');
const fs = require('fs');
const path = require('path');

const screenshots = [
  {
    url: 'https://anchor-browser.services.sapiom.ai/v1/tools/screenshots/screenshots/10b46fec-31e7-4404-94bd-ba5a9458c12f-mirage-social.polsia.app.png',
    filename: 'feed-01-good-shots.png'
  },
  {
    url: 'https://anchor-browser.services.sapiom.ai/v1/tools/screenshots/screenshots/85dbe3cb-b76a-4a82-9018-792fe4663557-mirage-social.polsia.app.png',
    filename: 'feed-02-good-vibes.png'
  },
  {
    url: 'https://anchor-browser.services.sapiom.ai/v1/tools/screenshots/screenshots/715ae3a3-2166-4390-861c-6498b6e7b292-mirage-social.polsia.app.png',
    filename: 'feed-03-good-tips.png'
  },
  {
    url: 'https://anchor-browser.services.sapiom.ai/v1/tools/screenshots/screenshots/6dd67982-8714-451b-994c-9bd1eb1a6bd0-mirage-social.polsia.app.png',
    filename: 'feed-04-hey-mirage.png'
  }
];

const dir = 'public/archive/screenshots';
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

async function downloadAll() {
  for (let i = 0; i < screenshots.length; i++) {
    const shot = screenshots[i];
    console.log(`Downloading ${shot.filename}...`);

    const filePath = path.join(dir, shot.filename);
    const file = fs.createWriteStream(filePath);

    try {
      await new Promise((resolve, reject) => {
        const req = https.get(shot.url, (res) => {
          console.log(`  Status: ${res.statusCode}`);
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          res.pipe(file);
          file.on('finish', () => {
            file.close();
            const size = fs.statSync(filePath).size;
            console.log(`  Saved: ${size} bytes`);
            resolve();
          });
        });
        req.on('error', (e) => {
          reject(e);
        });
        req.setTimeout(10000, () => {
          req.destroy();
          reject(new Error('Timeout'));
        });
      });
    } catch(e) {
      console.error(`  Failed: ${e.message}`);
    }

    if (i < screenshots.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  console.log('Done!');
}

downloadAll().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});