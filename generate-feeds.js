const OpenAI = require('openai');
const openai = new OpenAI();

const feeds = [
  {
    name: 'good-shots',
    label: 'Good Shots',
    prompt: 'Mobile app screenshot of a social network feed called Good Shots. 9:16 portrait vertical format. Light blue sky background header with app name. Posts show photos with captions. A post from Dustfox_33 at the fest reads: sunset over the main stage just hit different tonight. Shows emoji reactions (flower, blue heart, clap hands). Blue location badge shows at the fest. Clean mobile UI, minimal white cards, sky blue theme, desert festival aesthetic. Phone-style screenshot, no browser chrome.'
  },
  {
    name: 'good-vibes',
    label: 'Good Vibes',
    prompt: 'Mobile app screenshot of a social network feed called Good Vibes. 9:16 portrait vertical format. Light blue sky background header with app name. Posts are text-only kind messages. A post from Cactusbird_7 at the fest reads: that set just changed something in me. grateful to be here. A post from Mesaowl_22 in the desert reads: strangers becoming friends at 2am in the desert. this is the only place like this in the world. Clean mobile UI, white cards, sky blue theme. Phone-style screenshot.'
  },
  {
    name: 'good-tips',
    label: 'Good Tips',
    prompt: 'Mobile app screenshot of a social network feed called Good Tips. 9:16 portrait vertical format. Light blue sky background header with app name. Posts are helpful information. A post from Sandyowl_14 in the desert: I-10 westbound backed up past cathedral city, take highway 111. A post from Dustcreek_9 at the fest: main stage set starting 10 minutes late. confirmed by staff at the rail. A post from Saltflat_3 at the fest: medical tent near the east entrance is clear right now if anyone needs it. Clean mobile UI, information cards. Phone-style screenshot.'
  },
  {
    name: 'hey-mirage',
    label: 'Hey Mirage',
    prompt: 'Mobile app screenshot of a social network page called Hey Mirage. 9:16 portrait vertical format. Light blue sky background header with app name. Shows a private note section for sending feedback to the Mirage team. Text reads: private note — only the Mirage team sees this. A text area says: leave feedback, ideas, anything you want heard. Blue send button. Clean mobile UI, sky blue theme. Phone-style screenshot.'
  }
];

async function generateFeeds() {
  const fs = require('fs');
  const path = require('path');

  // Ensure screenshots dir exists
  const dir = 'public/archive/screenshots';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  for (let i = 0; i < feeds.length; i++) {
    const feed = feeds[i];
    const filename = `feed-0${i + 1}-${feed.name}.png`;

    console.log(`Generating ${feed.label}...`);
    try {
      const image = await openai.images.generate({
        model: 'dall-e-3',
        prompt: feed.prompt,
        size: '1024x1024',
      });

      const url = image.data[0].url;
      console.log(`URL: ${url}`);

      // Download the image
      const https = require('https');
      const filePath = path.join(dir, filename);
      const file = fs.createWriteStream(filePath);

      https.get(url, (response) => {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log(`Saved: ${filePath}`);
        });
      }).on('error', (err) => {
        console.error(`Download error for ${feed.label}:`, err.message);
      });

    } catch (e) {
      console.error(`Error generating ${feed.label}:`, e.message);
    }

    // Rate limit between calls
    if (i < feeds.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

generateFeeds().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});