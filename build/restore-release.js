const fs = require('fs');
const path = require('path');

// CONV2 has index.html in src/renderer/
const indexPath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const backupPath = path.join(__dirname, 'index.html.bak');

if (!fs.existsSync(backupPath)) {
  console.error('✗ No backup found at build/index.html.bak');
  process.exit(1);
}

fs.copyFileSync(backupPath, indexPath);
console.log('✓ Restored index.html from backup');

fs.unlinkSync(backupPath);
console.log('✓ Removed build/index.html.bak');
