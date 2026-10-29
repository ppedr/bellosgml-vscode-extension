'use strict';

// Compares this formatter with a reference pretty-printer on real files. The
// reference tool is called as `<tool> <input> <output>`.
// Usage: node test/compare-with-reference.js <tool> <file.sgml>...
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { format } = require('../lib/formatter');

const [tool, ...files] = process.argv.slice(2);
if (!tool || !files.length) {
    console.error('usage: node test/compare-with-reference.js <tool> <file.sgml>...');
    process.exit(2);
}

let failed = 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bellosgml-cmp-'));
for (const file of files) {
    const refPath = path.join(tmp, 'ref.sgml');
    fs.rmSync(refPath, { force: true });
    const r = spawnSync(tool, [file, refPath], { stdio: 'inherit' });
    if (r.status !== 0) {
        console.log(`SKIP ${file}: reference tool exited with ${r.status}`);
        continue;
    }
    // Latin-1 keeps the comparison byte-for-byte.
    const ref = fs.readFileSync(refPath, 'latin1');
    const started = Date.now();
    const mine = format(fs.readFileSync(file, 'latin1'));
    const ms = Date.now() - started;
    if (mine === ref) {
        console.log(`OK   ${file} (${ref.length} bytes, ${ms} ms)`);
        continue;
    }
    failed++;
    const a = ref.split('\r\n');
    const b = mine.split('\r\n');
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    console.log(`DIFF ${file} at output line ${i + 1}`);
    console.log(`  ref : ${JSON.stringify(a[i])}`);
    console.log(`  ours: ${JSON.stringify(b[i])}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
