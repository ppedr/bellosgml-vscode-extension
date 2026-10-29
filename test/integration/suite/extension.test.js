'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { format } = require('../../../lib/formatter');
const { makeManual } = require('../../../scripts/bench-structure');

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures', 'integration');
const EXTENSION_ID = 'ppfjuni.bellosgml';

function fixture(name) {
    return vscode.workspace.openTextDocument(path.join(FIXTURES, name));
}

// Compact view of a symbol tree: "a(b,c(d))".
function shape(symbols) {
    return symbols.map((s) => s.name + (s.children.length ? `(${shape(s.children)})` : '')).join(',');
}

function countSymbols(symbols) {
    let n = 0;
    const work = [...symbols];
    while (work.length) {
        const s = work.pop();
        n++;
        work.push(...s.children);
    }
    return n;
}

function symbols(uri) {
    return vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
}

async function withSetting(section, key, value, fn) {
    const cfg = vscode.workspace.getConfiguration(section);
    await cfg.update(key, value, vscode.ConfigurationTarget.Global);
    try {
        return await fn();
    } finally {
        await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
    }
}

async function timed(fn) {
    const started = Date.now();
    const result = await fn();
    return { result, ms: Date.now() - started };
}

before(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID).activate();
});

describe('language', () => {
    it('opens .sgm and .sgml files as SGML without any configuration', async () => {
        assert.strictEqual((await fixture('manual.sgm')).languageId, 'sgml');
        assert.strictEqual((await fixture('unformatted.sgml')).languageId, 'sgml');
    });

    it('makes this extension the default SGML formatter', () => {
        const editor = vscode.workspace.getConfiguration('editor', { languageId: 'sgml' });
        assert.strictEqual(editor.get('defaultFormatter'), EXTENSION_ID);
        const associations = vscode.workspace.getConfiguration('files').get('associations');
        assert.strictEqual(associations['*.sgm'], 'sgml');
        assert.strictEqual(associations['*.sgml'], 'sgml');
    });
});

describe('formatter', () => {
    afterEach(() => vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor'));

    it('Format Document pretty-prints in place, with the line endings of the document', async () => {
        const doc = await fixture('unformatted.sgml');
        const original = doc.getText();
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand('editor.action.formatDocument');
        const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
        const expected = format(original, { indent: '\t', wrapWidth: 80, eol, finalNewline: false });
        assert.notStrictEqual(expected, original);
        assert.strictEqual(doc.getText(), expected);
    });

    it('leaves documents above bellosgml.largeFileSizeMB alone', async () => {
        const doc = await fixture('unformatted.sgml');
        await vscode.window.showTextDocument(doc);
        const edits = await withSetting('bellosgml', 'largeFileSizeMB', 0.00001, () =>
            vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', doc.uri, { tabSize: 4, insertSpaces: false })
        );
        assert.deepStrictEqual(edits || [], []);
    });
});

describe('element hierarchy', () => {
    it('document symbols follow the elements, with omitted end tags', async () => {
        const doc = await fixture('manual.sgm');
        const tree = await symbols(doc.uri);
        // revst/revend and graphic have no end tags: they are empty. The last
        // item's end tag is omitted and </list> closes it.
        assert.strictEqual(
            shape(tree),
            'dmodule(idstatus(dmaddres(dmc)),content(para(revst,revend),para(graphic,list(item,item)),para(emph)))'
        );
        const content = tree[0].children[1];
        assert.strictEqual(content.detail, 'c1');
        assert.deepStrictEqual(content.children.map((p) => p.detail), ['p1', 'p2', 'p3']);
        const list = content.children[1].children[1];
        assert.strictEqual(list.detail, 'numbered');

        // The item whose end tag is omitted ends on its own line, not on </list>'s.
        const lastItem = list.children[1];
        const line = doc.lineAt(lastItem.range.start.line).text;
        assert.ok(line.startsWith('<item>two'));
        assert.strictEqual(lastItem.range.end.line, lastItem.range.start.line);
        assert.strictEqual(lastItem.range.end.character, line.length);
        // The selection range is the element name.
        assert.strictEqual(doc.getText(lastItem.selectionRange), 'item');
    });

    it('folding ranges cover multi-line elements and comments', async () => {
        const doc = await fixture('manual.sgm');
        const ranges = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', doc.uri);
        const lineOf = (s) => doc.getText().split(/\r?\n/).findIndex((l) => l.startsWith(s));
        const has = (start, end, kind) => ranges.some((r) => r.start === start && r.end === end && r.kind === kind);
        // The end tag stays visible: dmodule folds up to the line before </dmodule>.
        assert.ok(has(lineOf('<dmodule>'), lineOf('</dmodule>') - 1, undefined), 'dmodule');
        assert.ok(has(lineOf('<list'), lineOf('</list>') - 1, undefined), 'list');
        assert.ok(has(lineOf('<!--'), lineOf('-->'), vscode.FoldingRangeKind.Comment), 'comment');
    });

    it('copies the element path under the cursor', async () => {
        const doc = await fixture('manual.sgm');
        const editor = await vscode.window.showTextDocument(doc);
        const at = doc.positionAt(doc.getText().indexOf('emphasis'));
        editor.selection = new vscode.Selection(at, at);
        assert.strictEqual(await vscode.commands.executeCommand('sgml.copyElementPath', { indexed: true }), '/dmodule/content/para[3]/emph');
        assert.strictEqual(await vscode.env.clipboard.readText(), '/dmodule/content/para[3]/emph');
        assert.strictEqual(await vscode.commands.executeCommand('sgml.copyElementPath', { indexed: false }), '/dmodule/content/para/emph');
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });

    it('sgml.emptyElements changes the hierarchy', async () => {
        const doc = await fixture('manual.sgm');
        // list has an end tag, so only the setting makes it empty.
        const tree = await withSetting('sgml', 'emptyElements', ['LIST'], () => symbols(doc.uri));
        assert.strictEqual(shape([tree[0].children[1].children[1]]), 'para(graphic,list,item,item)');
    });

    it('is turned off above sgml.hierarchy.maxFileSizeMB', async () => {
        const doc = await fixture('manual.sgm');
        const tree = await withSetting('sgml', 'hierarchy.maxFileSizeMB', 0.0001, () => symbols(doc.uri));
        assert.deepStrictEqual(tree || [], []);
    });

    it('handles a 20 MB document', async function () {
        this.timeout(300000);
        const file = path.join(os.tmpdir(), 'bellosgml-20mb.sgm');
        fs.writeFileSync(file, makeManual(20));
        try {
            const opened = await timed(() => vscode.workspace.openTextDocument(file));
            const doc = opened.result;
            // The first request parses the document; the others reuse the parse.
            const first = await timed(() => symbols(doc.uri));
            const folding = await timed(() => vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', doc.uri));
            const editor = await vscode.window.showTextDocument(doc);
            const at = doc.positionAt(Math.floor(doc.getText().length / 2));
            editor.selection = new vscode.Selection(at, at);
            const copied = await timed(() => vscode.commands.executeCommand('sgml.copyElementPath', { indexed: true }));
            const all = await withSetting('sgml', 'hierarchy.maxSymbols', 10000000, () => timed(() => symbols(doc.uri)));
            const shown = countSymbols(first.result);
            const total = countSymbols(all.result);
            console.log(
                `      20 MB document, ${doc.lineCount} lines, ${total} elements:\n` +
                    `        open ${opened.ms} ms\n` +
                    `        parse + symbols ${first.ms} ms (${shown} symbols with the default sgml.hierarchy.maxSymbols)\n` +
                    `        folding ${folding.ms} ms (${folding.result.length} ranges)\n` +
                    `        element path ${copied.ms} ms → ${copied.result}\n` +
                    `        every element as a symbol: parse + symbols ${all.ms} ms`
            );
            assert.ok(total > 700000);
            assert.ok(shown <= 100000 && shown > 1000, `${shown} symbols`);
            // The top levels are complete: every chapter and task is there.
            assert.ok(first.result[0].children.every((c) => c.name !== 'chapter' || c.children.some((t) => t.name === 'task')));
            assert.match(copied.result, /^\/manual\/chapter\[\d+\]\/task\[\d+\]\//);
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        } finally {
            fs.rmSync(file, { force: true });
        }
    });

    it('defaults sgml.hierarchy.maxFileSizeMB to 50 and caps higher values', async () => {
        const doc = await fixture('manual.sgm');
        const tree = await withSetting('sgml', 'hierarchy.maxFileSizeMB', 1000, () => symbols(doc.uri));
        assert.strictEqual(tree[0].name, 'dmodule');
        const inspected = vscode.workspace.getConfiguration('sgml').inspect('hierarchy.maxFileSizeMB');
        assert.strictEqual(inspected.defaultValue, 50);
    });

    // SGML_SAMPLE=path/to/real.sgml times a real document (not part of the
    // regular run).
    const sample = process.env.SGML_SAMPLE;
    (sample ? it : it.skip)(`handles ${sample ? path.basename(sample) : 'a real document (set SGML_SAMPLE)'}`, async function () {
        this.timeout(600000);
        const opened = await timed(() => vscode.workspace.openTextDocument(sample));
        const doc = opened.result;
        const first = await timed(() => symbols(doc.uri));
        const folding = await timed(() => vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', doc.uri));
        const editor = await vscode.window.showTextDocument(doc);
        const offset = doc.getText().indexOf('<PARA>', Math.floor(doc.getText().length / 2)) + 8;
        editor.selection = new vscode.Selection(doc.positionAt(offset), doc.positionAt(offset));
        const copied = await timed(() => vscode.commands.executeCommand('sgml.copyElementPath', { indexed: true }));
        console.log(
            `      ${path.basename(sample)}, ${doc.lineCount} lines:\n` +
                `        open ${opened.ms} ms\n` +
                `        parse + symbols ${first.ms} ms (${countSymbols(first.result)} symbols)\n` +
                `        folding ${folding.ms} ms (${folding.result.length} ranges)\n` +
                `        element path ${copied.ms} ms → ${copied.result}`
        );
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });
});
