// Prints a one-line-per-test summary of coverage/e2e/junit.xml.
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2] || path.join(__dirname, '..', 'coverage', 'e2e', 'junit.xml');
const decode = (s) =>
  s
    .replace(/&#10;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const xml = fs.readFileSync(file, 'utf8');
let failed = 0;
for (const m of xml.matchAll(/<testcase name="([^"]+)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)) {
  const body = m[3] || '';
  const isFail = /<failure/.test(body);
  const isSkip = /<skipped/.test(body);
  if (isFail) failed += 1;
  const msg = body.match(/message="([^"]{0,300})/);
  const tag = isFail ? 'FAIL' : isSkip ? 'skip' : 'ok  ';
  console.log(`${tag} ${decode(m[1])}${isFail && msg ? `\n     | ${decode(msg[1])}` : ''}`);
}
console.log(`failed: ${failed}`);
