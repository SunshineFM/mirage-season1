const fs = require('fs');
const content = fs.readFileSync('public/season1.html', 'utf8');
const lines = content.split('\n');
const line = lines[1443]; // line 1444 (0-indexed)
console.log('Line 1444:');
console.log(line);
console.log('---');
console.log('JSON:');
console.log(JSON.stringify(line));
console.log('---');
console.log('Contains $163:', line.includes('$163'));
console.log('Contains total spend:', line.includes('total spend'));
console.log('Contains asset-stat-pill:', line.includes('asset-stat-pill'));