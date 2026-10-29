'use strict';

// Measures the element-tree parse on a synthetic technical manual, or on a
// real document.
// Usage: node scripts/bench-structure.js [sizeMB=20] [out.sgml]
//        node scripts/bench-structure.js path/to/file.sgml
// With a second argument the generated document is also written to disk.
const fs = require('fs');
const { parse } = require('../lib/sgml-structure');
const { decode } = require('../lib/fileio');

// Chapters of tasks with steps whose paragraphs omit their end tags, tables
// with empty colspec elements, comments and entity references.
function makeManual(sizeMB) {
    const target = sizeMB * 1024 * 1024;
    const parts = [
        '<!DOCTYPE manual PUBLIC "-//ACME//DTD Manual//EN" [\n<!ENTITY % local "INCLUDE">\n<!ELEMENT graphic - O EMPTY>\n]>\n',
        '<manual>\n<front><title>Synthetic maintenance manual</title></front>\n',
    ];
    let size = parts[0].length + parts[1].length;
    // Stops before going over the target, so the size asked for is a ceiling.
    for (let chapter = 1; ; chapter++) {
        let s = `<chapter id="ch${chapter}">\n<title>Chapter ${chapter}</title>\n`;
        for (let task = 1; task <= 20; task++) {
            s += `<task id="t${chapter}-${task}" revdate=20240101>\n<title>Task ${task}</title>\n<!-- task ${task} -->\n`;
            for (let step = 1; step <= 8; step++) {
                s += `<step><para>Remove the <emph>bolt</emph> (&mdash; ref ${step}) and inspect the part for damage.\n`;
                s += `<para>Torque to ${step * 10} N&middot;m.</step>\n`;
            }
            s += '<table frame=all><tgroup cols=2><colspec colname=c1><colspec colname=c2><tbody>\n';
            for (let row = 1; row <= 5; row++) s += `<row><entry>Item ${row}</entry><entry>${row * 3}</entry></row>\n`;
            s += '</tbody></tgroup></table>\n<graphic boardno="ICN-01">\n</task>\n';
        }
        s += '</chapter>\n';
        if (size + s.length + 10 > target) break;
        parts.push(s);
        size += s.length;
    }
    parts.push('</manual>\n');
    return parts.join('');
}

module.exports = { makeManual };

if (require.main === module) {
    const arg = process.argv[2] || '20';
    let text;
    if (fs.existsSync(arg)) {
        text = decode(fs.readFileSync(arg)).text;
    } else {
        text = makeManual(Number(arg));
        if (process.argv[3]) fs.writeFileSync(process.argv[3], text);
    }

    parse(text); // warm-up
    const runs = [];
    let result;
    for (let i = 0; i < 5; i++) {
        const started = process.hrtime.bigint();
        result = parse(text);
        runs.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    runs.sort((a, b) => a - b);
    const lines = text.split('\n').length;
    console.log(`${(text.length / 1024 / 1024).toFixed(2)} MB, ${lines} lines, ${result.elementCount} elements`);
    console.log(`parse: median ${runs[2].toFixed(0)} ms (min ${runs[0].toFixed(0)}, max ${runs[4].toFixed(0)})`);
}
