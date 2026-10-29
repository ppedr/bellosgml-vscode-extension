'use strict';

// Tokenizes the same text with this SGML grammar and with VS Code's XML grammar,
// colours both with Dark+ and Light+ the way VS Code does (vscode-textmate's
// theme resolution), and checks that every character gets the same colour.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const vsctm = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

const ROOT = path.join(__dirname, '..');
const VSCODE = path.join(__dirname, 'fixtures', 'vscode');
const GRAMMARS = {
    'text.sgml': path.join(ROOT, 'syntaxes', 'sgml.tmLanguage.json'),
    'text.xml': path.join(VSCODE, 'xml.tmLanguage.json'),
};

// Foreground colour index: bits 15-23 of the encoded token metadata.
const FOREGROUND_MASK = 0x00ff8000;
const FOREGROUND_OFFSET = 15;

const onigLib = oniguruma
    .loadWASM(fs.readFileSync(path.join(path.dirname(require.resolve('vscode-oniguruma')), 'onig.wasm')).buffer)
    .then(() => ({
        createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
        createOnigString: (s) => new oniguruma.OnigString(s),
    }));

// Theme files are JSON with comments and trailing commas; `include` is resolved
// the way VS Code does it (included rules first).
function loadTheme(file) {
    const theme = vm.runInNewContext('(' + fs.readFileSync(path.join(VSCODE, file), 'utf8') + ')');
    const base = theme.include ? loadTheme(path.basename(theme.include)) : { colors: {}, tokenColors: [] };
    return {
        colors: { ...base.colors, ...theme.colors },
        tokenColors: [...base.tokenColors, ...(theme.tokenColors || [])],
    };
}

async function colourer(themeFile) {
    const theme = loadTheme(themeFile);
    const registry = new vsctm.Registry({
        onigLib,
        loadGrammar: async (scopeName) => {
            const file = GRAMMARS[scopeName];
            return file ? vsctm.parseRawGrammar(fs.readFileSync(file, 'utf8'), file) : null;
        },
    });
    registry.setTheme({
        settings: [
            { settings: { foreground: theme.colors['editor.foreground'], background: theme.colors['editor.background'] } },
            ...theme.tokenColors.filter((r) => r.scope),
        ],
    });
    const colorMap = registry.getColorMap();
    const grammars = {
        sgml: await registry.loadGrammar('text.sgml'),
        xml: await registry.loadGrammar('text.xml'),
    };
    // One colour per character, lines joined with '\n'.
    return (language, text) => {
        const grammar = grammars[language];
        let stack = vsctm.INITIAL;
        const colours = [];
        for (const line of text.split('\n')) {
            const { tokens, ruleStack } = grammar.tokenizeLine2(line, stack);
            stack = ruleStack;
            for (let i = 0; i < tokens.length; i += 2) {
                const end = i + 2 < tokens.length ? tokens[i + 2] : line.length;
                const colour = colorMap[(tokens[i + 1] & FOREGROUND_MASK) >>> FOREGROUND_OFFSET];
                // Whitespace has no glyph, so its colour is never visible.
                for (let c = tokens[i]; c < end; c++) if (line[c].trim()) colours.push(`${line[c]} ${colour}`);
            }
            colours.push('\\n');
        }
        return colours;
    };
}

// Constructs that exist in both languages, written identically.
const SAMPLES = {
    'element with attributes': '<para id="p001" class=\'note\' title="a &amp; b">text</para>',
    'names with - . _ and digits': '<dm.code-x_1 a.b-c_d="v">x</dm.code-x_1>',
    'tag split across lines': '<graphic boardno="ICN-01"\n  reprowid="50mm">\n</graphic>',
    'self-closing tag': '<colspec colname="c1"/>',
    'nested elements': '<a>\n  <b>x</b>\n</a>',
    'comment': '<!-- a comment -->\n<!--\n  multi-line <tag> &amp;\n-->',
    'entity and character references': '<a>&amp; &#123; &#x1F; text</a>',
    'processing instruction': '<?xml version="1.0" encoding="UTF-8"?>',
    'doctype': '<!DOCTYPE dmodule>',
    'doctype with internal subset': '<!DOCTYPE dmodule [\n<!ENTITY ent "value &amp; more">\n<!-- note -->\n]>',
    'CDATA section': '<a><![CDATA[ x < y && z ]]></a>',
};

for (const themeFile of ['dark_plus.json', 'light_plus.json']) {
    test(`SGML and XML get the same colours with ${themeFile}`, async (t) => {
        const colour = await colourer(themeFile);
        for (const [name, text] of Object.entries(SAMPLES)) {
            await t.test(name, () => assert.deepStrictEqual(colour('sgml', text), colour('xml', text)));
        }
    });
}
