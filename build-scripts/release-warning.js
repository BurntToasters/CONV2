#!/usr/bin/env node
const red = '\x1b[31m';
const reset = '\x1b[0m';
const msg =
  '[!!WARNING!!] The release scripts are DESTRUCTIVE! Any local changes to this branch will be lost after the script is done.';
console.error(`\n${red}${msg}${reset}\n`);

// Pause so the warning is read; the process exits when the timer ends.
setTimeout(() => {}, 3000);
