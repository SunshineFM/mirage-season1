const fs = require('fs');

// 9:16 portrait, base width 375, height 667
const W = 375;
const H = 667;

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&apos;').replace(/'/g,'&#39;');
}

function svgHeader() {
  return '<?xml version=\u00221.0\u0022 encoding=\u0022UTF-8\u0022?>\n' +
'<svg xmlns=\u0022http://www.w3.org/2000/svg\u0022 width=\u0022'+W+'\u0022 height=\u0022'+H+'\u0022 viewBox=\u00220 0 '+W+' '+H+'\u0022>\n' +
'<defs><style>\n' +
'.bg{fill:#fff}.header{fill:#0284C7}.card{fill:#fff;stroke:#e2e8f0;stroke-width:1}\n' +
'.nickname{fill:#0284c7;font-family:sans-serif;font-size:11px;font-weight:600}\n' +
'.location{fill:#475569;font-family:sans-serif;font-size:10px}\n' +
'.post-text{fill:#0f172a;font-family:sans-serif;font-size:13px}\n' +
'.reaction{fill:#475569;font-family:sans-serif;font-size:11px}\n' +
'.feed-desc{fill:#475569;font-family:sans-serif;font-size:11px;font-style:italic}\n' +
'.app-name{fill:#fff;font-family:sans-serif;font-size:28px;font-weight:bold}\n' +
'.feed-title{fill:#fff;font-family:sans-serif;font-size:16px}\n' +
'.hint{fill:#475569;font-family:sans-serif;font-size:11px}\n' +
'.badge{fill:#e0f2fe}.tab-inactive{fill:#475569;font-family:sans-serif;font-size:11px}\n' +
'.hey-label{fill:#0284c7;font-family:sans-serif;font-size:11px;font-weight:600}\n' +
'.hey-sub{fill:#475569;font-family:sans-serif;font-size:10px}\n' +
'.hey-btn{fill:#0284c7}.hey-btn-text{fill:#fff;font-family:sans-serif;font-size:11px;font-weight:600}\n' +
'</style></defs>';
}

function rect(x,y,w,h,r,fill,stroke,sw) {
  const strokeAttr = stroke ? ' stroke=\u0022'+stroke+'\u0022 stroke-width=\u0022'+sw+'\u0022' : '';
  return '<rect x=\u0022'+x+'\u0022 y=\u0022'+y+'\u0022 width=\u0022'+w+'\u0022 height=\u0022'+h+'\u0022 rx=\u0022'+r+'\u0022 fill=\u0022'+fill+'\u0022'+strokeAttr+'/>';
}

function text(x,y,t,cls) {
  return '<text x=\u0022'+x+'\u0022 y=\u0022'+y+'\u0022 class=\u0022'+cls+'\u0022>'+esc(t)+'</text>';
}

function drawPostCard(y, nickname, location, postText, reactions) {
  let svg = rect(16, y, W-32, 110, 10, '#ffffff', '#e2e8f0', 1);
  svg += rect(28, y+14, 150, 18, 6, '#e0f2fe');
  svg += text(34, y+26, '@'+nickname, 'nickname');
  svg += text(110, y+26, '  '+location, 'location');
  const words = postText.split(' ');
  let line = '';
  let lines = [];
  for (const word of words) {
    const test = (line + ' ' + word).trim();
    if (test.length > 35) { lines.push(line); line = word; }
    else line = test;
  }
  if (line) lines.push(line);
  for (let i = 0; i < Math.min(lines.length, 3); i++) {
    svg += text(28, y+42+i*16, lines[i], 'post-text');
  }
  let rx = 28;
  for (const [emoji, count] of reactions) {
    svg += text(rx, y+82, emoji+' '+count, 'reaction');
    rx += 68;
  }
  return svg;
}

function generateFeed(filename, feedTitle, feedDesc, posts, tabIndex) {
  const tabs = ['Good Shots','Good Vibes','Good Tips','Hey Mirage'];
  let svg = svgHeader();
  svg += rect(0, 0, W, H, 0, '#ffffff');
  svg += rect(0, 0, W, 90, 0, '#0284c7');
  svg += text(20, 30, 'mirage', 'app-name');
  svg += text(20, 62, feedTitle, 'feed-title');
  svg += rect(0, 90, W, 44, 0, '#ffffff');
  svg += rect(0, 133, W, 1, 0, '#e2e8f0');
  let tx = 20;
  for (let i = 0; i < tabs.length; i++) {
    svg += text(tx, 112, tabs[i], i === tabIndex ? 'nickname' : 'tab-inactive');
    tx += 72;
  }
  svg += text(W-70, 112, 'swipe \u2192', 'hint');
  svg += text(20, 157, feedDesc, 'feed-desc');
  let py = 178;
  for (const post of posts) {
    svg += drawPostCard(py, post.nickname, post.location, post.text, post.reactions);
    py += 120;
  }
  svg += text(20, H-30, '\ud83c\udf3d tap any post to react', 'hint');
  svg += '</svg>';
  fs.writeFileSync(filename, svg);
  console.log('Saved: ' + filename);
}

const dir = 'public/archive/screenshots';
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

generateFeed(dir+'/feed-01-good-shots.svg','Good Shots','photos only \u2014 captions are optional',[
  {nickname:'dustfox_33',location:'at the fest',text:'sunset over the main stage just hit different tonight. nothing prepared me for this.',reactions:[['\ud83d\udc90',12],['\ud83d\udc98',8],['\ud83d\udc4f',5]]},
  {nickname:'sageowl_4',location:'in the desert',text:'caught the art installation at golden hour. this is what it is all about.',reactions:[['\ud83d\udc90',7],['\ud83d\udc98',4]]},
],0);

generateFeed(dir+'/feed-02-good-vibes.svg','Good Vibes','leave some love \u2014 a kind word, a lyric, anything that lifts the mood',[
  {nickname:'cactusbird_7',location:'at the fest',text:'that set just changed something in me. grateful to be here. all of us, right now.',reactions:[['\ud83d\udc90',18],['\ud83d\udc98',15]]},
  {nickname:'mesaowl_22',location:'in the desert',text:'strangers becoming friends at 2am in the desert. this is the only place like this in the world.',reactions:[['\ud83d\udc90',23],['\ud83d\udc98',11],['\ud83d\udc4f',7]]},
],1);

generateFeed(dir+'/feed-03-good-tips.svg','Good Tips','helpful info for festivalgoers \u2014 tips, lost and found, anything worth knowing',[
  {nickname:'sandyowl_14',location:'in the desert',text:'I-10 westbound backed up past cathedral city, take highway 111.',reactions:[['\ud83d\udc90',9],['\ud83d\udc98',3]]},
  {nickname:'dustcreek_9',location:'at the fest',text:'main stage set starting 10 minutes late. confirmed by staff at the rail.',reactions:[['\ud83d\udc90',6],['\ud83d\udc4f',2]]},
  {nickname:'saltflat_3',location:'at the fest',text:'medical tent near the east entrance is clear right now if anyone needs it.',reactions:[['\ud83d\udc90',14],['\ud83d\udc98',8]]},
],2);

// Hey Mirage special
let svg = svgHeader();
svg += rect(0,0,W,H,0,'#ffffff');
svg += rect(0,0,W,90,0,'#0284c7');
svg += text(20,30,'mirage','app-name');
svg += text(20,62,'Hey Mirage','feed-title');
svg += rect(0,90,W,44,0,'#ffffff');
svg += rect(0,133,W,1,0,'#e2e8f0');
let tx=20; const tabs=['Good Shots','Good Vibes','Good Tips','Hey Mirage'];
for(let i=0;i<tabs.length;i++){svg+=text(tx,112,tabs[i],i===3?'nickname':'tab-inactive');tx+=72;}
svg += text(W-70,112,'swipe \u2192','hint');
svg += text(20,157,'private note \u2014 only the Mirage team sees this','feed-desc');
svg += rect(16,180,W-32,180,10,'#ffffff','#e2e8f0',1);
svg += text(28,200,'\u2709 private note','hey-label');
svg += text(28,218,'only the Mirage team sees this','hey-sub');
svg += rect(28,240,W-56,60,8,'#f0f9ff','#e2e8f0',1);
svg += text(36,262,'leave feedback, ideas,','hey-sub');
svg += text(36,280,'anything you want heard...','hey-sub');
svg += rect(W-108,305,80,28,8,'#0284c7');
svg += text(W-100,322,'send \u2192','hey-btn-text');
svg += text(20,H-30,'\ud83c\udf3d tap any post to react','hint');
svg += '</svg>';
fs.writeFileSync(dir+'/feed-04-hey-mirage.svg',svg);
console.log('Saved: '+dir+'/feed-04-hey-mirage.svg');
console.log('\nAll SVG feed screenshots generated!');