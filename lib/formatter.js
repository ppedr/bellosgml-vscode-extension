'use strict';

// SGML pretty-printer. The pipeline:
//   1. read physical lines, trim them, drop empty ones and join them into
//      "logical lines" that always end with '>';
//   2. split logical lines into tag/text tokens, one output line per token,
//      merging adjacent text, wrapping text at `wrapWidth` and sorting the
//      attributes of start tags;
//   3. walk the output lines backwards to compute the indentation.

// Whitespace is " \n\t\v\r\f" plus NBSP. NBSP is matched as a whole character,
// so UTF-8 characters such as "à" (C3 A0) or "°" (C2 B0) at token edges are
// never touched.
function isWs(c) {
    return c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0;
}

function trim(s) {
    let start = 0;
    let end = s.length;
    while (start < end && isWs(s.charCodeAt(start))) start++;
    while (end > start && isWs(s.charCodeAt(end - 1))) end--;
    return start === 0 && end === s.length ? s : s.slice(start, end);
}

function isText(s) {
    return s.indexOf('<') === -1 && s.indexOf('>') === -1;
}

// Greedy wrap: break after the last space at or before `width`; a piece with
// no such space is kept whole. The trailing space stays on the broken line.
function wrap(s, width, out) {
    while (s.length) {
        if (width >= s.length) {
            out.push(s);
            return;
        }
        const p = s.lastIndexOf(' ', width);
        if (p === -1) {
            out.push(s);
            return;
        }
        out.push(s.slice(0, p + 1));
        s = s.slice(p + 1);
    }
}

// Start-tag normalisation. A space splits attributes only when the counter
// (number of '=' plus matching quote characters since the last split) is
// exactly 3, i.e. after one complete name="value". The first split separates
// the element name. Attributes are then sorted with a plain string compare.
function normalizeStartTag(tag) {
    const parts = [];
    let start = 0;
    let count = 3;
    let quote = 0;
    for (let i = 0; i < tag.length; i++) {
        const c = tag.charCodeAt(i);
        if (c === 0x22 || c === 0x27) {
            if (quote === 0 || quote === c) {
                quote = c;
                count++;
            }
        } else if (c === 0x20) {
            // The space itself starts the next part; trim() drops it.
            if (count === 3) {
                parts.push(trim(tag.slice(start, i)));
                start = i;
                quote = 0;
                count = 0;
            }
        } else if (c === 0x3d) {
            count++;
        }
    }
    parts.push(trim(tag.slice(start)));

    const name = parts.shift();
    if (parts.length) {
        const i = parts.length - 1;
        const last = parts[i];
        if (last.indexOf('/>') !== -1) parts[i] = last.slice(0, last.length - 2);
        else if (last.length) parts[i] = last.slice(0, last.length - 1);
        parts.sort(compare);
    }

    let out = name + ' ';
    for (const p of parts) out += p + ' ';
    out = trim(out);
    if (tag.indexOf('/>') !== -1 && out.indexOf('/>') === -1) out += '/>';
    else if (out.indexOf('>') === -1) out += '>';
    return out;
}

function compare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

function isNormalizableTag(s) {
    return s.indexOf('<') !== -1 &&
        s.indexOf('</') === -1 &&
        s.indexOf('<?') === -1 &&
        s.indexOf('<!') === -1;
}

class LineBuilder {
    constructor(wrapWidth) {
        this.wrapWidth = wrapWidth;
        this.lines = [];
    }

    // Called for every non-empty token. The previous line is finalised (text
    // wrapped, start tag normalised) only once the next token is known.
    push(tok) {
        const lines = this.lines;
        const n = lines.length;
        if (n) {
            const last = lines[n - 1];
            if (isText(last)) {
                if (isText(tok)) {
                    lines[n - 1] = last + ' ' + tok;
                    return;
                }
                lines.pop();
                wrap(last, this.wrapWidth, lines);
            } else if (isNormalizableTag(last)) {
                lines[n - 1] = normalizeStartTag(last);
            }
        }
        lines.push(tok);
    }

    // The last token has no successor, so it is finalised here.
    finish() {
        const lines = this.lines;
        const n = lines.length;
        if (!n) return lines;
        const last = lines[n - 1];
        if (isText(last)) {
            lines.pop();
            wrap(last, this.wrapWidth, lines);
        } else if (isNormalizableTag(last)) {
            lines[n - 1] = normalizeStartTag(last);
        }
        return lines;
    }
}

function tokenizeLogicalLine(line, builder) {
    let pos = 0;
    const len = line.length;
    while (pos < len) {
        const lt = line.indexOf('<', pos);
        let end;
        if (lt === -1) {
            end = len;
        } else if (lt === pos) {
            const gt = line.indexOf('>', pos);
            end = gt === -1 ? len : gt + 1;
        } else {
            end = lt;
        }
        const tok = trim(line.slice(pos, end));
        pos = end;
        if (tok) builder.push(tok);
    }
}

// Shares of the total time measured on a 42 MB file; joining takes the rest.
const BUILD_SHARE = 0.68;
const INDENT_SHARE = 0.23;

// Progress is checked once every PROGRESS_STEP lines so the cost stays negligible.
const PROGRESS_STEP = 0x3fff;

function buildLines(input, wrapWidth, progress) {
    const builder = new LineBuilder(wrapWidth);
    let acc = '';
    let pos = 0;
    let count = 0;
    const len = input.length;
    while (pos < len) {
        if ((++count & PROGRESS_STEP) === 0) progress(pos / len);
        let nl = input.indexOf('\n', pos);
        if (nl === -1) nl = len;
        // A CR of a CRLF pair is removed by trim(); a lone CR is not a line break.
        const line = trim(input.slice(pos, nl));
        pos = nl + 1;
        if (!line) continue;
        if (line[line.length - 1] !== '>') {
            acc += ' ' + line;
            continue;
        }
        tokenizeLogicalLine(acc + ' ' + line, builder);
        acc = '';
    }
    // A trailing chunk that does not end with '>' is kept too.
    if (acc) tokenizeLogicalLine(acc, builder);
    return builder.finish();
}

// Indentation is computed from the end of the document. Every line containing
// "</" is indented at the current depth, which then grows, and its name is
// pushed. A line containing "<" + top-of-stack (a substring match) and no "/>"
// closes that level. The last entry of the stack is never popped, and the depth
// never goes below zero.
function indentLines(lines, indentUnit, progress) {
    const indents = [''];
    const indentFor = (depth) => {
        if (depth <= 0) return '';
        while (indents.length <= depth) indents.push(indents[indents.length - 1] + indentUnit);
        return indents[depth];
    };

    const stack = [];
    let depth = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
        if ((i & PROGRESS_STEP) === 0) progress(1 - i / lines.length);
        const line = lines[i];
        if (line.indexOf('</') !== -1) {
            // Lines are already trimmed, so this is the name between "</" and ">".
            stack.push(line.length >= 3 ? line.substr(2, line.length - 3) : line.slice(2));
            lines[i] = indentFor(depth) + line;
            depth++;
        } else if (stack.length &&
            line.indexOf('<' + stack[stack.length - 1]) !== -1 &&
            line.indexOf('/>') === -1) {
            depth--;
            lines[i] = indentFor(depth) + line;
            if (stack.length >= 2) stack.pop();
        } else {
            lines[i] = indentFor(depth) + line;
        }
    }
    return lines;
}

/**
 * Pretty-print SGML text.
 * @param {string} input
 * @param {{indent?: string, wrapWidth?: number, eol?: string, finalNewline?: boolean}} [options]
 * @param {(fraction: number) => void} [onProgress] called with the completed fraction (0..1) as work advances
 * @returns {string}
 */
function format(input, options = {}, onProgress) {
    const indent = options.indent === undefined ? '\t' : options.indent;
    // 0 disables wrapping.
    const wrapWidth = options.wrapWidth === undefined ? 80 : options.wrapWidth > 0 ? options.wrapWidth : Infinity;
    const eol = options.eol === undefined ? '\r\n' : options.eol;
    const report = onProgress || (() => {});
    if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
    const lines = buildLines(input, wrapWidth, (f) => report(f * BUILD_SHARE));
    indentLines(lines, indent, (f) => report(BUILD_SHARE + f * INDENT_SHARE));
    const out = lines.join(eol);
    report(1);
    return options.finalNewline && out ? out + eol : out;
}

module.exports = { format, normalizeStartTag, wrap, trim };
