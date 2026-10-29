'use strict';

// Runs the formatter off the extension host thread so large documents do not
// freeze VS Code. Sends { progress } messages (0..1, at most one per percent)
// before the final result.
const { parentPort, workerData } = require('worker_threads');
const { format } = require('./formatter');
const { formatFile } = require('./fileio');

let lastPercent = -1;
function onProgress(fraction) {
    const percent = Math.floor(fraction * 100);
    if (percent === lastPercent) return;
    lastPercent = percent;
    parentPort.postMessage({ progress: fraction });
}

try {
    if (workerData.kind === 'text') {
        parentPort.postMessage({ text: format(workerData.text, workerData.options, onProgress) });
    } else {
        parentPort.postMessage({
            stats: formatFile(workerData.inputPath, workerData.outputPath, workerData.options, onProgress),
        });
    }
} catch (err) {
    parentPort.postMessage({ error: err && err.stack ? err.stack : String(err) });
}
