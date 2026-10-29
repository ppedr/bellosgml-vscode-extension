'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { tempPathFor } = require('./lib/fileio');

const WORKER_PATH = path.join(__dirname, 'lib', 'worker.js');

function readOptions(uri) {
    const cfg = vscode.workspace.getConfiguration('bellosgml', uri);
    const indentSize = Math.min(Math.max(cfg.get('indent', 0), 0), 8);
    return {
        indent: indentSize === 0 ? '\t' : ' '.repeat(indentSize),
        wrapWidth: cfg.get('wrapWidth', 80),
        lineEnding: cfg.get('lineEnding', 'crlf'),
        finalNewline: cfg.get('insertFinalNewline', false),
    };
}

// Opening a huge file costs VS Code far more than formatting it (the 42 MB
// example becomes 71 MB and 2 million lines), so above the size limit the
// output is only opened when the user asks for it.
function shouldOpenOutput(uri, inputBytes) {
    const cfg = vscode.workspace.getConfiguration('bellosgml', uri);
    const limitMB = cfg.get('largeFileSizeMB', 5);
    return inputBytes <= limitMB * 1024 * 1024 || cfg.get('openLargeFileOutput', false);
}

function runWorker(workerData, token, onProgress) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_PATH, { workerData });
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            if (sub) sub.dispose();
            worker.terminate();
            fn(value);
        };
        const sub = token && token.onCancellationRequested(() => finish(reject, new vscode.CancellationError()));
        worker.on('message', (msg) => {
            if (msg.progress !== undefined) {
                if (onProgress && !settled) onProgress(msg.progress);
            } else if (msg.error) finish(reject, new Error(msg.error));
            else finish(resolve, msg);
        });
        worker.once('error', (err) => finish(reject, err));
        worker.once('exit', (code) => finish(reject, new Error(`Formatter worker exited with code ${code}`)));
    });
}

function formatDuration(seconds) {
    if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
    return `${Math.round(seconds / 60)} min`;
}

// Feeds worker progress into a progress notification: percentage plus an
// estimate of the time left, so it is clear the work is advancing.
function progressReporter(progress) {
    const started = Date.now();
    let shown = 0;
    return (fraction) => {
        const percent = Math.min(99, Math.floor(fraction * 100));
        if (percent <= shown) return;
        const elapsed = (Date.now() - started) / 1000;
        // Early estimates swing too much to be useful.
        const left = percent >= 5 && elapsed >= 1 ? ` · about ${formatDuration(elapsed / fraction - elapsed)} left` : '';
        progress.report({ increment: percent - shown, message: `${percent}%${left}` });
        shown = percent;
    };
}

// The copy is made from the file on disk, so unsaved changes are saved first.
async function saveIfDirty(uri) {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (!open || !open.isDirty) return true;
    const answer = await vscode.window.showWarningMessage(
        `Bello SGML: ${path.basename(uri.fsPath)} has unsaved changes. Save it before pretty-printing?`,
        'Save', 'Use file on disk'
    );
    if (answer === 'Save') return open.save();
    return answer === 'Use file on disk';
}

// Same pattern as the menu `when` clauses in package.json, which hide the command
// for copies. The keybinding stays on so Shift+Alt+F in a copy explains itself
// instead of falling through to VS Code's "no formatter installed" prompt.
const BELLO_COPY = /\.bello(\.\d+)?\.sgml?$/i;

// Never overwrite an earlier copy: name.bello.sgml, then name.bello.1.sgml, name.bello.2.sgml…
function freeOutputPath(parsed) {
    let candidate = path.join(parsed.dir, `${parsed.name}.bello${parsed.ext}`);
    for (let n = 1; fs.existsSync(candidate); n++) {
        candidate = path.join(parsed.dir, `${parsed.name}.bello.${n}${parsed.ext}`);
    }
    return candidate;
}

async function formatToCopy(uri) {
    if (!uri || uri.scheme !== 'file') {
        vscode.window.showWarningMessage('Bello SGML: open or select an SGML file saved on disk first.');
        return;
    }
    if (BELLO_COPY.test(uri.fsPath)) {
        vscode.window.showInformationMessage(
            `Bello SGML: ${path.basename(uri.fsPath)} is already pretty-printed. Run it on the original file to make a new copy.`
        );
        return;
    }
    if (!(await saveIfDirty(uri))) return;
    const input = uri.fsPath;
    const parsed = path.parse(input);
    const output = freeOutputPath(parsed);
    const inputBytes = fs.statSync(input).size;
    const started = Date.now();
    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Bello SGML: pretty-printing ${parsed.base}`, cancellable: true },
            (progress, token) => runWorker(
                { kind: 'file', inputPath: input, outputPath: output, options: readOptions(uri) },
                token,
                progressReporter(progress)
            )
        );
    } catch (err) {
        // A cancelled run can stop the worker halfway through writing.
        fs.rmSync(tempPathFor(output), { force: true });
        throw err;
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const outputUri = vscode.Uri.file(output);
    if (shouldOpenOutput(uri, inputBytes)) {
        await vscode.window.showTextDocument(outputUri);
        return;
    }
    const choice = await vscode.window.showInformationMessage(
        `Bello SGML: wrote ${path.basename(output)} in ${seconds}s. It is large, so opening it can take a while.`,
        'Open'
    );
    if (choice === 'Open') await vscode.window.showTextDocument(outputUri);
}

// Explorer passes the clicked file; the keybinding and the editor menu pass
// nothing, so use the active tab (which also covers files above 50 MB, which
// VS Code never hands to the extension API as text editors).
function activeTabUri() {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return tab && tab.input && tab.input.uri instanceof vscode.Uri ? tab.input.uri : undefined;
}

function guard(fn) {
    return async (...args) => {
        try {
            await fn(...args);
        } catch (err) {
            if (err instanceof vscode.CancellationError) return;
            vscode.window.showErrorMessage(`Bello SGML: ${err.message || err}`);
        }
    };
}

function activate(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand('bellosgml.formatFileToNew', guard(async (uri) => {
            await formatToCopy(uri instanceof vscode.Uri ? uri : activeTabUri());
        }))
    );
}

function deactivate() {}

module.exports = { activate, deactivate };
