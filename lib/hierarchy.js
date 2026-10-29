'use strict';

// Element hierarchy in the editor: document symbols (which feed Breadcrumbs,
// Outline and Sticky Scroll), folding ranges, the element path in the status
// bar and the "Copy Element Path" command. All of them share one parse per
// document version.
const vscode = require('vscode');
const path = require('path');
const { parse, elementAt, ancestry, elementPath, attributeDetail } = require('./sgml-structure');
const { LineIndex } = require('./line-index');

const SELECTOR = { language: 'sgml' };
const STATUS_DEBOUNCE_MS = 150;
// Cancellation is checked once every this many elements.
const CANCEL_CHECK = 0x1fff;
// The status bar shows at most this many levels; the tooltip has the full path.
const STATUS_LEVELS = 6;
// VS Code does not give extensions documents larger than this, so a higher
// sgml.hierarchy.maxFileSizeMB would have no effect.
const VSCODE_SYNC_LIMIT_MB = 50;

function readSettings(uri) {
    const cfg = vscode.workspace.getConfiguration('sgml', uri);
    return {
        emptyElements: cfg.get('emptyElements', []),
        inferEmptyElements: cfg.get('hierarchy.inferEmptyElements', true),
        maxFileSizeMB: Math.min(cfg.get('hierarchy.maxFileSizeMB', VSCODE_SYNC_LIMIT_MB), VSCODE_SYNC_LIMIT_MB),
    };
}

function documentLength(document) {
    const last = document.lineAt(document.lineCount - 1);
    return document.offsetAt(last.range.end);
}

class StructureCache {
    constructor(log) {
        this.log = log;
        /** @type {Map<string, {version: number, text: string, structure: ReturnType<typeof parse>, lines: LineIndex}>} */
        this.entries = new Map();
        this.warned = new Set();
    }

    /** The parsed document, or null when it is larger than the limit. */
    get(document) {
        const key = document.uri.toString();
        const settings = readSettings(document.uri);
        // The settings are part of the cache key: a configuration change event
        // can arrive after a provider has already been asked again.
        const settingsKey = JSON.stringify(settings);
        const cached = this.entries.get(key);
        if (cached && cached.version === document.version && cached.settingsKey === settingsKey) return cached;

        const limit = settings.maxFileSizeMB * 1024 * 1024;
        const length = documentLength(document);
        if (length > limit) {
            this.entries.delete(key);
            this.warnTooLarge(document, settings.maxFileSizeMB);
            return null;
        }

        const started = Date.now();
        const text = document.getText();
        let structure;
        try {
            structure = parse(text, settings);
        } catch (err) {
            // The parser is written not to throw; this keeps a bug from
            // breaking the editor features.
            this.log.error(`Could not parse ${document.uri.fsPath}: ${err && err.stack ? err.stack : err}`);
            structure = { roots: [], blocks: [], elementCount: 0 };
        }
        const lines = new LineIndex(text);
        const ms = Date.now() - started;
        this.log.info(`Parsed ${path.basename(document.uri.fsPath)} (${(length / 1024 / 1024).toFixed(1)} MB, ${structure.elementCount} elements) in ${ms} ms`);
        const entry = { version: document.version, settingsKey, text, structure, lines, parseMs: ms };
        this.entries.set(key, entry);
        return entry;
    }

    warnTooLarge(document, limitMB) {
        const key = document.uri.toString();
        if (this.warned.has(key)) return;
        this.warned.add(key);
        vscode.window.showWarningMessage(
            `Bello SGML: ${path.basename(document.uri.fsPath)} is larger than ${limitMB} MB, so breadcrumbs, Outline, Sticky Scroll, folding and the element path are turned off for it.`,
            'Change Limit'
        ).then((choice) => {
            if (choice) vscode.commands.executeCommand('workbench.action.openSettings', 'sgml.hierarchy.maxFileSizeMB');
        });
    }

    forget(document) {
        this.entries.delete(document.uri.toString());
    }
}

function position(lines, offset) {
    const line = lines.lineAt(offset);
    return new vscode.Position(line, offset - lines.lineStart(line));
}

// Number of tree levels, from the top, that hold at most `max` elements in
// total (at least 1). Infinity when the whole tree fits.
function levelsWithin(roots, max) {
    let level = roots;
    let total = 0;
    for (let depth = 0; level.length; depth++) {
        total += level.length;
        if (total > max) return Math.max(depth, 1);
        const next = [];
        for (const node of level) for (const child of node.children) next.push(child);
        level = next;
    }
    return Infinity;
}

/**
 * Document symbols for the parsed document. Every symbol costs time in the
 * extension host and in the window, so above `maxSymbols` elements only the
 * top levels of the tree are returned (the status bar still shows the full
 * path). Returns `{symbols, levels, count}`, or undefined when cancelled.
 */
function symbolsFor(entry, token, maxSymbols = Infinity) {
    const { text, structure, lines } = entry;
    const levels = structure.elementCount > maxSymbols ? levelsWithin(structure.roots, maxSymbols) : Infinity;
    const roots = [];
    // Iterative walk (documents with omitted end tags can nest very deeply),
    // with each element next to the list its symbol goes into and its depth.
    const nodes = [];
    const targets = [];
    const depths = [];
    for (let i = structure.roots.length - 1; i >= 0; i--) {
        nodes.push(structure.roots[i]);
        targets.push(roots);
        depths.push(0);
    }
    let count = 0;
    while (nodes.length) {
        if ((++count & CANCEL_CHECK) === 0 && token.isCancellationRequested) return undefined;
        const node = nodes.pop();
        const siblings = targets.pop();
        const depth = depths.pop();
        const symbol = new vscode.DocumentSymbol(
            node.name,
            attributeDetail(text, node),
            vscode.SymbolKind.Field,
            new vscode.Range(position(lines, node.start), position(lines, node.end)),
            new vscode.Range(position(lines, node.nameStart), position(lines, node.nameEnd))
        );
        siblings.push(symbol);
        if (depth + 1 >= levels) continue;
        const children = node.children;
        for (let i = children.length - 1; i >= 0; i--) {
            nodes.push(children[i]);
            targets.push(symbol.children);
            depths.push(depth + 1);
        }
    }
    return { symbols: roots, levels, count };
}

function isFirstOnLine(text, lines, line, offset) {
    for (let i = lines.lineStart(line); i < offset; i++) {
        const c = text.charCodeAt(i);
        if (c !== 0x20 && c !== 0x09) return false;
    }
    return true;
}

/**
 * Folding ranges for multi-line elements, comments and marked sections. VS
 * Code keeps at most `maxRegions` of them, the outermost first, so deeper
 * element levels are dropped here before any FoldingRange is created.
 */
function foldingRangesFor(entry, token, maxRegions = Infinity) {
    const { text, structure, lines } = entry;
    const ranges = [];
    for (const block of structure.blocks) {
        const startLine = lines.lineAt(block.start);
        const endLine = lines.lineAt(Math.max(block.start, block.end - 1));
        if (endLine > startLine) {
            const kind = block.kind === 'comment' ? vscode.FoldingRangeKind.Comment : vscode.FoldingRangeKind.Region;
            ranges.push(new vscode.FoldingRange(startLine, endLine, kind));
        }
    }
    // Element regions as (start line, end line, depth) triples.
    const found = [];
    const perDepth = [];
    const work = structure.roots.slice().reverse();
    const depths = work.map(() => 0);
    let visited = 0;
    while (work.length) {
        if ((++visited & CANCEL_CHECK) === 0 && token.isCancellationRequested) return undefined;
        const node = work.pop();
        const depth = depths.pop();
        const startLine = lines.lineAt(node.start);
        let endLine;
        if (node.endTagStart >= 0) {
            // Keep an end tag that starts its own line visible, like XML/HTML.
            endLine = lines.lineAt(node.endTagStart);
            if (isFirstOnLine(text, lines, endLine, node.endTagStart)) endLine--;
        } else {
            endLine = lines.lineAt(Math.max(node.start, node.end - 1));
        }
        if (endLine > startLine) {
            found.push(startLine, endLine, depth);
            perDepth[depth] = (perDepth[depth] || 0) + 1;
        }
        const children = node.children;
        for (let i = children.length - 1; i >= 0; i--) {
            work.push(children[i]);
            depths.push(depth + 1);
        }
    }
    let levels = perDepth.length;
    let total = ranges.length;
    for (let d = 0; d < perDepth.length; d++) {
        total += perDepth[d] || 0;
        if (total > maxRegions) {
            levels = Math.max(d, 1);
            break;
        }
    }
    for (let i = 0; i < found.length; i += 3) {
        if (found[i + 2] < levels) ranges.push(new vscode.FoldingRange(found[i], found[i + 1]));
    }
    return ranges;
}

function register(context) {
    const log = vscode.window.createOutputChannel('Bello SGML', { log: true });
    const cache = new StructureCache(log);

    const elementAtCursor = (editor) => {
        if (!editor || editor.document.languageId !== 'sgml') return null;
        const entry = cache.get(editor.document);
        if (!entry) return null;
        const offset = editor.document.offsetAt(editor.selection.active);
        const node = elementAt(entry.structure.roots, offset);
        return node ? { node, roots: entry.structure.roots } : null;
    };

    const status = vscode.window.createStatusBarItem('sgml.elementPath', vscode.StatusBarAlignment.Right, 101);
    status.name = 'SGML Element Path';
    status.command = { command: 'sgml.copyElementPath', title: 'Copy Element Path', arguments: [{ indexed: false }] };

    const updateStatus = () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'sgml') {
            status.hide();
            return;
        }
        const found = elementAtCursor(editor);
        if (!found) {
            // Outside any element, or the document is too large.
            status.hide();
            return;
        }
        const names = ancestry(found.node).map((n) => n.name);
        const shown = names.length > STATUS_LEVELS ? ['…', ...names.slice(-STATUS_LEVELS)] : names;
        status.text = `$(symbol-field) ${shown.join(' > ')}`;
        const tooltip = new vscode.MarkdownString();
        tooltip.appendText(names.join(' > '));
        tooltip.appendMarkdown('\n\nClick to copy `' + elementPath(found.node, found.roots, false).replace(/`/g, '') + '`');
        status.tooltip = tooltip;
        status.show();
    };

    let timer;
    const scheduleStatus = () => {
        clearTimeout(timer);
        timer = setTimeout(updateStatus, STATUS_DEBOUNCE_MS);
    };

    const symbolProvider = {
        provideDocumentSymbols(document, token) {
            const entry = cache.get(document);
            if (!entry) return [];
            const started = Date.now();
            const maxSymbols = vscode.workspace.getConfiguration('sgml', document.uri).get('hierarchy.maxSymbols', 100000);
            const result = symbolsFor(entry, token, maxSymbols);
            if (!result) return undefined;
            const limited = result.levels === Infinity ? '' : `, limited to the top ${result.levels} levels by sgml.hierarchy.maxSymbols`;
            log.info(`Symbols for ${path.basename(document.uri.fsPath)}: ${result.count} of ${entry.structure.elementCount} elements${limited}, in ${Date.now() - started} ms`);
            return result.symbols;
        },
    };
    const foldingProvider = {
        provideFoldingRanges(document, _context, token) {
            const entry = cache.get(document);
            if (!entry) return [];
            const maxRegions = vscode.workspace.getConfiguration('editor', document).get('foldingMaximumRegions', 5000);
            return foldingRangesFor(entry, token, maxRegions);
        },
    };
    // VS Code keeps the symbols of a document version; registering the
    // providers again is the way to make it ask again after a setting change.
    let providers;
    const registerProviders = () => {
        if (providers) providers.dispose();
        providers = vscode.Disposable.from(
            vscode.languages.registerDocumentSymbolProvider(SELECTOR, symbolProvider, { label: 'SGML' }),
            vscode.languages.registerFoldingRangeProvider(SELECTOR, foldingProvider)
        );
    };
    registerProviders();

    context.subscriptions.push(
        log,
        status,
        { dispose: () => clearTimeout(timer) },
        { dispose: () => providers.dispose() },
        vscode.commands.registerCommand('sgml.copyElementPath', async (args) => {
            const found = elementAtCursor(vscode.window.activeTextEditor);
            if (!found) {
                vscode.window.showInformationMessage('Bello SGML: place the cursor inside an SGML element to copy its path.');
                return undefined;
            }
            let indexed = args && typeof args.indexed === 'boolean' ? args.indexed : undefined;
            if (indexed === undefined) {
                const simple = elementPath(found.node, found.roots, false);
                const xpath = elementPath(found.node, found.roots, true);
                const pick = await vscode.window.showQuickPick(
                    [
                        { label: simple, description: 'Element path', indexed: false },
                        { label: xpath, description: 'XPath with positions', indexed: true },
                    ],
                    { title: 'Copy Element Path' }
                );
                if (!pick) return undefined;
                indexed = pick.indexed;
            }
            const value = elementPath(found.node, found.roots, indexed);
            await vscode.env.clipboard.writeText(value);
            vscode.window.setStatusBarMessage(`$(copy) Copied ${value}`, 3000);
            return value;
        }),
        vscode.window.onDidChangeTextEditorSelection((e) => {
            if (e.textEditor === vscode.window.activeTextEditor) scheduleStatus();
        }),
        vscode.window.onDidChangeActiveTextEditor(scheduleStatus),
        vscode.workspace.onDidChangeTextDocument((e) => {
            const editor = vscode.window.activeTextEditor;
            if (editor && e.document === editor.document) scheduleStatus();
        }),
        vscode.workspace.onDidCloseTextDocument((document) => cache.forget(document)),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (!e.affectsConfiguration('sgml')) return;
            registerProviders();
            scheduleStatus();
        })
    );
    scheduleStatus();
}

module.exports = { register, symbolsFor, foldingRangesFor };
