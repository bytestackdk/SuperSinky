/* Runs every Super Sinky test suite in turn. */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const suites = [
  ['mechanics', 'mechanics.test.js', 'game rules in isolation'],
  ['client', 'client.test.js', 'client rendering against a stubbed canvas'],
  ['e2e', 'e2e.test.js', 'real HTTP + WebSocket against a live server']
];

const only = process.argv[2];
let failed = 0;

for (const [name, file, blurb] of suites) {
  if (only && only !== name) continue;
  console.log('\n================ ' + name + ' : ' + blurb + ' ================');
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

console.log('\n' + (failed === 0 ? 'ALL SUITES PASSED' : failed + ' SUITE(S) FAILED'));
process.exit(failed === 0 ? 0 : 1);
