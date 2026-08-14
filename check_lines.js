const fs = require('fs');
const lines = fs.readFileSync('/opt/polsia/workspaces/company-39476/agent-30/exec-2047061/desertdrop/public/season1.html', 'utf8').split('\n');
for (let i = 1310; i <= 1316; i++) {
  console.log((i+1) + ': ' + JSON.stringify(lines[i]));
}