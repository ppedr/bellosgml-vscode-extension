'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { scan } = require('../lib/sgml-scanner');
const { parse, elementAt, elementPath, attributeDetail } = require('../lib/sgml-structure');

// Compact view of a tree: "a(b,c(d))".
function shape(nodes) {
    return nodes.map((n) => n.name + (n.children.length ? `(${shape(n.children)})` : '')).join(',');
}

function tree(text, options) {
    return shape(parse(text, options).roots);
}

function pathAt(text, marker, indexed = false, options) {
    const { roots } = parse(text, options);
    const node = elementAt(roots, text.indexOf(marker));
    return node ? elementPath(node, roots, indexed) : null;
}

test('nests explicitly closed elements', () => {
    assert.strictEqual(tree('<a><b>x</b><c><d>y</d></c></a>'), 'a(b,c(d))');
});

test('names are case-insensitive', () => {
    assert.strictEqual(tree('<Para><Sub>x</SUB></PARA><next>'), 'Para(Sub),next');
});

test('names may contain - . _ and digits', () => {
    assert.strictEqual(tree('<dm.code-x_1><a2>x</a2></dm.code-x_1>'), 'dm.code-x_1(a2)');
});

test('an end tag closes the elements opened after its element', () => {
    // b and c have end tags elsewhere, so they are not empty; </a> closes both.
    const text = '<a><b><c>x</a><b>y</b><c>z</c>';
    assert.strictEqual(tree(text), 'a(b(c)),b,c');
    const [a] = parse(text).roots;
    const b = a.children[0];
    assert.ok(b.implicitEnd && b.children[0].implicitEnd);
    assert.strictEqual(text.slice(b.start, b.end), '<b><c>x');
});

test('an orphan end tag is ignored', () => {
    assert.strictEqual(tree('<a><b>x</b></zzz></b>y</a>'), 'a(b)');
});

test('elements left open end at the end of the document, before trailing blanks', () => {
    const text = '<a>x<b>y</b>\n\n  ';
    const [a] = parse(text, { inferEmptyElements: false }).roots;
    assert.strictEqual(a.end, text.indexOf('</b>') + 4);
    assert.ok(a.implicitEnd);
});

test('elements that are never closed are taken as empty', () => {
    const text = '<tgroup><colspec colname=c1><colspec colname=c2><row><entry>a</entry></row></tgroup>';
    assert.strictEqual(tree(text), 'tgroup(colspec,colspec,row(entry))');
    assert.strictEqual(pathAt(text, 'a</entry>'), '/tgroup/row/entry');
});

test('milestones followed by text stay empty (REVST/REVEND in a real manual)', () => {
    const text =
        '<PARA><REVST>Attitude&sol;Thrust<REVEND></PARA>\n' +
        '<PARA>turn off all <ACRO IDCODE="ACR-0000114"><REVST>ECS<REVEND></ACRO><REVST> valves and open the <REVEND><ACRO>x</ACRO></PARA>';
    assert.strictEqual(tree(text), 'PARA(REVST,REVEND),PARA(ACRO(REVST,REVEND),REVST,REVEND,ACRO)');
    assert.strictEqual(pathAt(text, 'valves', true), '/PARA[2]');
});

test('an element closed only by its parent ends before the parent end tag line', () => {
    // item has end tags elsewhere, so the last one is closed by </list>.
    const text = '<list>\n<item>one</item>\n<item>two\n</list>';
    assert.strictEqual(tree(text), 'list(item,item)');
    const last = parse(text).roots[0].children[1];
    assert.strictEqual(text.slice(last.start, last.end), '<item>two');
    assert.ok(last.implicitEnd);
});

test('inference can be turned off, leaving only the configured list', () => {
    const text = '<a><br><b>x</b></a>';
    assert.strictEqual(tree(text, { inferEmptyElements: false }), 'a(br(b))');
    assert.strictEqual(tree(text, { inferEmptyElements: false, emptyElements: ['BR'] }), 'a(br,b)');
});

test('sgml.emptyElements applies even to names that do have end tags', () => {
    assert.strictEqual(tree('<a><x><b>1</b></a><x></x>', { emptyElements: ['x'] }), 'a(x,b),x');
});

test('<!ELEMENT x - O EMPTY> in the internal subset marks x as empty', () => {
    const dtd = '<!DOCTYPE a [ <!ELEMENT img - O EMPTY> <!ELEMENT (br|hr) - O EMPTY -- comment -->\n<!ELEMENT p - O (#PCDATA)> ]>';
    // img is closed once by mistake, so only the declaration makes it empty.
    const text = `${dtd}<a><img><p>x</p><br><hr><p>y</p></a><img></img>`;
    assert.strictEqual(tree(text), 'a(img,p,br,hr,p),img');
});

test('self-closing tags are empty', () => {
    assert.strictEqual(tree('<a><b/><c>x</c></a><b></b>'), 'a(b,c),b');
});

test('</> closes the current element and <> reopens the last ended one', () => {
    assert.strictEqual(tree('<list><item>a</item><>b</></list>'), 'list(item,item)');
    // item is never closed by name.
    assert.strictEqual(tree('<list><item>a<b>x</b></><>b</></list>'), 'list(item(b),item)');
    // Here it is not followed by text either, so it was taken as empty until </>.
    assert.strictEqual(tree('<list><item><b>x</b></><><b>y</b></></list>'), 'list(item(b),item(b))');
    assert.strictEqual(tree('</><>x'), '');
});

test('comments, processing instructions and declarations are not elements', () => {
    const text = '<!-- <x> --><?Pub <y>><!ENTITY e "<z>"><a>t</a>';
    assert.strictEqual(tree(text), 'a');
});

test('CDATA, RCDATA and IGNORE marked sections hide their content', () => {
    const text = '<a><![ CDATA [ <x> ]]><![RCDATA[<y>]]><![ IGNORE [ <z><![ INCLUDE [ <w> ]]> ]]><b>1</b></a>';
    assert.strictEqual(tree(text), 'a(b)');
    assert.deepStrictEqual(parse(text).blocks.map((b) => b.kind), ['section', 'section', 'section']);
});

test('INCLUDE, TEMP and parameter-entity sections are parsed as markup', () => {
    const text = '<a><![ INCLUDE [ <b>1</b> ]]><![ %draft; [ <c>2</c> ]]><![ TEMP [<d>3</d>]]></a>';
    assert.strictEqual(tree(text), 'a(b,c,d)');
    const sections = parse(text).blocks.filter((b) => b.kind === 'section');
    assert.deepStrictEqual(sections.map((s) => text.slice(s.start, s.end)), [
        '<![ INCLUDE [ <b>1</b> ]]>',
        '<![ %draft; [ <c>2</c> ]]>',
        '<![ TEMP [<d>3</d>]]>',
    ]);
});

test('IGNORE wins over INCLUDE and %param; in the same status list', () => {
    assert.strictEqual(tree('<a><![ %x; INCLUDE IGNORE [ <b>1</b> ]]></a>'), 'a');
});

test('a quoted ">" does not end a tag; an unclosed tag ends at the next "<"', () => {
    assert.strictEqual(tree('<a title="x > y"><b>1</b></a>'), 'a(b)');
    assert.strictEqual(tree('<a<b>1</b></a>'), 'a(b)');
});

test('an apostrophe in an unquoted value does not open a literal', () => {
    assert.strictEqual(tree("<a title=don't><b>1</b></a><c x='1'>2</c>"), 'a(b),c');
});

test('elementAt finds the innermost element', () => {
    const text = '<dmodule><content><para>one</para><para>two <emph>three</emph></para></content></dmodule>';
    assert.strictEqual(pathAt(text, 'three'), '/dmodule/content/para/emph');
    assert.strictEqual(pathAt(text, 'two'), '/dmodule/content/para');
    assert.strictEqual(pathAt(text, 'two', true), '/dmodule/content/para[2]');
    assert.strictEqual(pathAt(text, '<dmodule>'), '/dmodule');
    // Right after an end tag the cursor is outside that element.
    const { roots } = parse(text);
    assert.strictEqual(elementAt(roots, text.length), null);
    assert.strictEqual(elementPath(elementAt(roots, text.indexOf('<para>two')), roots), '/dmodule/content/para');
});

test('elementAt stays inside an element whose end tag was omitted, up to its last character', () => {
    const text = '<list><p>first\n<q>x</q></list>';
    // p is closed by </list>; q has an end tag so p is not inferred empty.
    const { roots } = parse(text + '<p></p>');
    const p = roots[0].children[0];
    assert.strictEqual(elementPath(elementAt(roots, p.end), roots), '/list/p');
});

test('XPath positions count only siblings with the same name', () => {
    const text = '<a><b>1</b><c>2</c><b>3</b><c><d>4</d></c></a>';
    assert.strictEqual(pathAt(text, '3', true), '/a/b[2]');
    assert.strictEqual(pathAt(text, '4', true), '/a/c[2]/d');
});

test('attributeDetail prefers id, then the first attribute', () => {
    const detail = (text) => attributeDetail(text, parse(text).roots[0]);
    assert.strictEqual(detail('<para class="x" ID="p001">'), 'p001');
    assert.strictEqual(detail('<para id=p2>'), 'p2');
    assert.strictEqual(detail("<graphic boardno='ICN 01' reprowid=5>"), 'boardno=ICN 01');
    assert.strictEqual(detail('<list numbered compact>'), 'numbered');
    assert.strictEqual(detail('<para>'), '');
    assert.strictEqual(detail('<br/>'), '');
    assert.strictEqual(detail(`<a title="${'x'.repeat(200)}">`).length, 80);
});

test('the scanner reports offsets of every construct', () => {
    const events = [];
    const text = '<!DOCTYPE a [<!ENTITY e "v">]><a x="1">t&e;</a><?pi><!-- c --></>';
    const sink = {};
    for (const name of ['startTag', 'endTag', 'emptyStartTag', 'emptyEndTag', 'comment', 'pi', 'declaration']) {
        sink[name] = (start, ...rest) => {
            const end = name === 'startTag' || name === 'endTag' ? rest[2] : rest[0];
            events.push(`${name}:${text.slice(start, end)}`);
        };
    }
    scan(text, sink);
    assert.deepStrictEqual(events, [
        'declaration:<!ENTITY e "v">',
        'declaration:<!DOCTYPE a [<!ENTITY e "v">]>',
        'startTag:<a x="1">',
        'endTag:</a>',
        'pi:<?pi>',
        'comment:<!-- c -->',
        'emptyEndTag:</>',
    ]);
});

// Malformed input: none of these may throw, and every element range must lie
// inside the document with children inside their parent.

function checkRanges(text, nodes, parent) {
    for (const n of nodes) {
        assert.ok(n.start >= 0 && n.end <= text.length && n.start < n.end, `range of ${n.name}`);
        if (parent) assert.ok(n.start >= parent.start && n.end <= parent.end, `${n.name} inside ${parent.name}`);
        checkRanges(text, n.children, n);
    }
}

const MALFORMED = [
    '',
    '<',
    '<a',
    '<a x="unterminated>text</a>',
    "<a x='>",
    '</a></b></>',
    '<>',
    '<!',
    '<!-',
    '<!--',
    '<!-- unterminated <a>',
    '<![',
    '<![ CDATA [ unterminated',
    '<![ IGNORE [ <![ ]]>',
    '<![ INCLUDE [ <a>x',
    ']]> <a>]]></a>',
    '<!DOCTYPE a [ <!ELEMENT',
    '<!DOCTYPE a [ <!ELEMENT (b|c',
    '<!DOCTYPE a [ <!ELEMENT - O EMPTY> ]><a>',
    '<!DOCTYPE a [ <![ IGNORE [',
    '<?pi',
    '<a><b><c><d></a></d></c></b>',
    '<a/></a>',
    '< a>text</ a>',
    '&amp; text & <a>&#x1F;</a>',
    '<a b=c d="e" f g=\'h\' =i "j">',
];

test('malformed documents never throw and produce consistent ranges', () => {
    for (const text of MALFORMED) {
        const { roots } = parse(text);
        checkRanges(text, roots, null);
        for (let i = 0; i <= text.length; i++) elementAt(roots, i);
    }
});

test('random markup soup never throws', () => {
    const pieces = ['<a>', '</a>', '<b x="1">', '</b>', '<c/>', '<>', '</>', '<!--', '-->', '<![', 'CDATA', 'IGNORE',
        '%p;', '[', ']]>', '<?', '>', '<', '"', "'", '=', ' ', '\n', 'text', '<!DOCTYPE d [', ']', '<!ELEMENT c - O EMPTY>', '&e;'];
    let seed = 42;
    const random = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
    };
    for (let round = 0; round < 2000; round++) {
        let text = '';
        const n = Math.floor(random() * 40);
        for (let i = 0; i < n; i++) text += pieces[Math.floor(random() * pieces.length)];
        const { roots } = parse(text);
        checkRanges(text, roots, null);
        elementAt(roots, Math.floor(random() * (text.length + 1)));
    }
});

test('parsing time grows linearly', () => {
    // A pathological shape for naive parsers: many unclosed elements, many
    // orphan end tags and unterminated quotes.
    const unit = '<sec><p>text <x a="1">y</x>\n</nope>';
    const time = (copies) => {
        const text = unit.repeat(copies);
        const started = process.hrtime.bigint();
        parse(text, { inferEmptyElements: false });
        return Number(process.hrtime.bigint() - started);
    };
    time(1000);
    const small = Math.min(time(20000), time(20000));
    const large = Math.min(time(160000), time(160000));
    // 8x the input; quadratic behaviour would be ~64x.
    assert.ok(large / small < 24, `8x input took ${(large / small).toFixed(1)}x the time`);
});
