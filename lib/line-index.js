'use strict';

// Offset → line/character for a whole document, built once per parse. VS Code
// breaks lines at CRLF, LF and a lone CR, and so does this index.
class LineIndex {
    constructor(text) {
        let starts = new Int32Array(1024);
        let count = 1;
        const len = text.length;
        const hasCr = text.indexOf('\r') !== -1;
        for (let i = 0; i < len; i++) {
            let next = text.indexOf('\n', i);
            if (hasCr) {
                const cr = text.indexOf('\r', i);
                if (cr !== -1 && (next === -1 || cr < next - 1)) next = cr;
            }
            if (next === -1) break;
            if (count === starts.length) {
                const grown = new Int32Array(starts.length * 2);
                grown.set(starts);
                starts = grown;
            }
            starts[count++] = next + 1;
            i = next;
        }
        this.starts = starts;
        this.lineCount = count;
    }

    /** Zero-based line of `offset`. */
    lineAt(offset) {
        const starts = this.starts;
        let lo = 0;
        let hi = this.lineCount - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= offset) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    lineStart(line) {
        return this.starts[line];
    }
}

module.exports = { LineIndex };
