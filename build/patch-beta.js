const fs = require('fs');
const path = require('path');

// CONV2 has index.html in src/renderer/
const indexPath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const backupPath = path.join(__dirname, 'index.html.bak');

if (!fs.existsSync(indexPath)) {
  console.error('Error: index.html not found at ' + indexPath);
  process.exit(1);
}

fs.copyFileSync(indexPath, backupPath);
console.log('✓ Backed up index.html to build/index.html.bak');

let content = fs.readFileSync(indexPath, 'utf8');

// Adapt replacements for CONV2
// Replacing icon.png with icon-beta.png if it exists in the file
content = content.replace('icon.png', 'icon-beta.png');

// Add Beta label to title or header if possible
// This is a generic replacement based on IYERIS but adapted to be safe if tags don't match exactly
if (content.includes('</h1>')) {
    content = content.replace('</h1>', '</h1><span class="beta-label">Beta</span>');
}

fs.writeFileSync(indexPath, content, 'utf8');

console.log('✓ Patched index.html for beta build');
