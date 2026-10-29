'use strict';

const fs = require('fs');
const { format } = require('./formatter');

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// UTF-8 when the bytes are valid UTF-8, Latin-1 otherwise (each byte maps to
// one character, so nothing is lost on the way back).
function decode(buf) {
    const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const body = bom ? buf.subarray(3) : buf;
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
        return { text, encoding: 'utf8', bom };
    } catch {
        return { text: body.toString('latin1'), encoding: 'latin1', bom: false };
    }
}

function encode(text, encoding, bom) {
    const body = Buffer.from(text, encoding);
    return bom ? Buffer.concat([UTF8_BOM, body]) : body;
}

function resolveEol(lineEnding, text) {
    if (lineEnding === 'lf') return '\n';
    if (lineEnding === 'keep') return text.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
    return '\r\n';
}

function tempPathFor(outputPath) {
    return outputPath + '.bellosgml-tmp';
}

/**
 * Pretty-print a file on disk. Writing goes through a temporary file so an
 * in-place run never leaves a half-written document behind.
 * Reading and writing are fast next to formatting, so progress is the formatter's.
 */
function formatFile(inputPath, outputPath, options, onProgress) {
    const { text, encoding, bom } = decode(fs.readFileSync(inputPath));
    const eol = resolveEol(options.lineEnding, text);
    const out = format(text, { ...options, eol }, onProgress);
    const tmp = tempPathFor(outputPath);
    fs.writeFileSync(tmp, encode(out, encoding, bom));
    fs.renameSync(tmp, outputPath);
    return { encoding, inputChars: text.length, outputChars: out.length };
}

module.exports = { formatFile, resolveEol, decode, tempPathFor };
