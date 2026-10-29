'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { format } = require('../lib/formatter');
const { formatFile } = require('../lib/fileio');

// Inputs and their exact expected output (read as Latin-1 so the comparison is
// per byte).
const referenceCases = require('./fixtures/reference-cases.json');

test('matches the reference output', async (t) => {
    for (const c of referenceCases) {
        await t.test(c.name, () => assert.strictEqual(format(c.input), c.expected));
    }
});

test('sorts attributes and keeps quoted spaces', () => {
    assert.strictEqual(
        format('<TGROUP COLS="4" ALIGN="CENTER" CHAROFF="50" CHAR=" "><ROW>x</ROW></TGROUP>'),
        '<TGROUP ALIGN="CENTER" CHAR=" " CHAROFF="50" COLS="4">\r\n\t<ROW>\r\n\t\tx\r\n\t</ROW>\r\n</TGROUP>'
    );
});

test('empty elements without an end tag do not indent', () => {
    assert.strictEqual(
        format('<TGROUP><COLSPEC COLNAME="C1"><ROW>x</ROW></TGROUP>'),
        '<TGROUP>\r\n\t<COLSPEC COLNAME="C1">\r\n\t<ROW>\r\n\t\tx\r\n\t</ROW>\r\n</TGROUP>'
    );
});

test('wraps text after the last space at or before column 80', () => {
    const words = 'word '.repeat(40).trim();
    const out = format(`<A>${words}</A>`).split('\r\n');
    assert.deepStrictEqual(out.slice(1, 4).map((l) => l.length), [81, 81, 40]);
    assert.ok(out[1].endsWith(' '));
});

// Edge cases where a naive implementation mangles or loses data.

test('does not corrupt UTF-8 characters at token edges', () => {
    // Trimming the bytes C2 and A0 individually would break "à" (C3 A0) and "°" (C2 B0).
    assert.strictEqual(format('<A>vou à</A><B>°C</B>'), '<A>\r\n\tvou à\r\n</A>\r\n<B>\r\n\t°C\r\n</B>');
    assert.strictEqual(format('<A> x </A>'), '<A>\r\n\tx\r\n</A>');
});

test('normalises the last token of the file too', () => {
    // A trailing start tag still gets its attributes sorted, and trailing text is kept.
    assert.strictEqual(format('<A Y="2" X="1">'), '<A X="1" Y="2">');
    assert.strictEqual(format('<A>x</A>after'), '<A>\r\n\tx\r\n</A>\r\nafter');
});

test('keeps a trailing chunk that does not end with ">"', () => {
    assert.strictEqual(format('<A>x</A>\ntail text'), '<A>\r\n\tx\r\n</A>\r\ntail text');
});

test('never indents below zero', () => {
    assert.strictEqual(format('<A><AB>x</A>'), '<A>\r\n<AB>\r\n\tx\r\n</A>');
});

test('options', () => {
    const src = '<A><B>x</B></A>';
    assert.strictEqual(format(src, { indent: '    ' }), '<A>\r\n    <B>\r\n        x\r\n    </B>\r\n</A>');
    assert.strictEqual(format(src, { eol: '\n', finalNewline: true }), '<A>\n\t<B>\n\t\tx\n\t</B>\n</A>\n');
    const long = 'x '.repeat(100).trim();
    assert.strictEqual(format(`<A>${long}</A>`, { wrapWidth: 0 }), `<A>\r\n\t${long}\r\n</A>`);
});

test('reports increasing progress up to 1 without changing the output', () => {
    const src = '<A>\n<B X="1">text</B>\n</A>\n'.repeat(20000);
    const seen = [];
    const out = format(src, {}, (f) => seen.push(f));
    assert.strictEqual(out, format(src));
    assert.ok(seen.length > 2);
    assert.ok(seen.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= seen[i - 1])));
    assert.strictEqual(seen[seen.length - 1], 1);
});

test('formatFile keeps encoding and BOM', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bellosgml-'));
    try {
        const utf8 = path.join(dir, 'u.sgml');
        fs.writeFileSync(utf8, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<A>ação</A>', 'utf8')]));
        formatFile(utf8, utf8, { lineEnding: 'crlf' });
        assert.deepStrictEqual(fs.readFileSync(utf8), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<A>\r\n\tação\r\n</A>', 'utf8')]));

        const latin1 = path.join(dir, 'l.sgml');
        const out = path.join(dir, 'l.pretty.sgml');
        fs.writeFileSync(latin1, Buffer.from('<A>ação</A>\n', 'latin1'));
        formatFile(latin1, out, { lineEnding: 'keep' });
        assert.deepStrictEqual(fs.readFileSync(out), Buffer.from('<A>\n\tação\n</A>', 'latin1'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
