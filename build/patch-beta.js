const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const backupPath = path.join(__dirname, 'index.html.bak');

if (!fs.existsSync(indexPath)) {
  console.error('Error: index.html not found at ' + indexPath);
  process.exit(1);
}

fs.copyFileSync(indexPath, backupPath);
console.log('✓ Backed up index.html to build/index.html.bak');

let content = fs.readFileSync(indexPath, 'utf8');

// Patch <title>
content = content.replace(
  /<title>CONV2<\/title>/,
  '<title>CONV2 Beta</title>'
);

// Patch header h1 — insert Beta badge inside the heading
content = content.replace(
  /<h1>CONV2<\/h1>/,
  '<h1>CONV2 <span class="beta-label">Beta</span></h1>'
);

fs.writeFileSync(indexPath, content, 'utf8');

console.log('✓ Patched index.html for beta build');
