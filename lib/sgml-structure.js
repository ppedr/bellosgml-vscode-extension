'use strict';

// Element tree of an SGML document, for breadcrumbs, Outline, Sticky Scroll,
// folding and the element path. Built from the scanner's events in two linear
// passes and tolerant of anything: it never throws.
//
// Without a DTD, omitted end tags are resolved with a stack:
//   - `</x>` closes every element opened after the innermost open `x`;
//   - `</x>` with no open `x` is ignored;
//   - `</>` closes the current element; `<>` reopens the most recently ended
//     element (or the current one when none has ended yet);
//   - elements still open at the end of the document end there.
// Elements that never have content are recognised from `sgml.emptyElements`
// and `<x/>`. Unless inference is turned off, also from `<!ELEMENT x - O
// EMPTY>` in the internal subset and from names that never have an end tag in
// the document (the pretty-printer makes the same assumption when it indents).
// Text after such an element does not make it a container: milestones like
// `<REVST>text<REVEND>` are empty and followed by text.

const { scan, isWs } = require('./sgml-scanner');

const START = 0;
const START_SELF_CLOSING = 1;
const END = 2;
const EMPTY_START = 3;
const EMPTY_END = 4;
const EVENT_SIZE = 6;

// How the elements of a name are closed (see the top of the file).
const NORMAL = 0;
const EMPTY = 1;
const INFERRED_EMPTY = 2;

// Shared by every element without children until its first child arrives.
const NO_CHILDREN = Object.freeze([]);

class SgmlElement {
    constructor(name, key, keyId, start, nameStart, nameEnd, tagEnd, parent) {
        this.name = name;
        /** Lower-case name. */
        this.key = key;
        this.keyId = keyId;
        /** Offset of '<' of the start tag. */
        this.start = start;
        /** Offset after the end tag or, when it was omitted, after the last content. */
        this.end = tagEnd;
        this.nameStart = nameStart;
        this.nameEnd = nameEnd;
        /** Offset after the start tag. */
        this.tagEnd = tagEnd;
        /** Offset of the explicit end tag, or -1. */
        this.endTagStart = -1;
        /** True when the end was inferred (omitted end tag or end of document). */
        this.implicitEnd = false;
        this.parent = parent;
        /** @type {readonly SgmlElement[]} */
        this.children = NO_CHILDREN;
    }
}

function appendChild(parent, node) {
    if (parent.children === NO_CHILDREN) parent.children = [node];
    else parent.children.push(node);
}

/**
 * @param {string} text
 * @param {{emptyElements?: string[], inferEmptyElements?: boolean}} [options]
 * @returns {{roots: SgmlElement[], blocks: {start: number, end: number, kind: 'comment' | 'section'}[], elementCount: number}}
 */
function parse(text, options = {}) {
    const emptyElements = new Set((options.emptyElements || []).map((n) => String(n).toLowerCase()));
    const infer = options.inferEmptyElements !== false;

    // Names are interned: each spelling gets an id, and each case-folded name
    // a key id, so the tree is built without slicing or lower-casing again.
    const spellingIds = new Map();
    const spellings = [];
    const spellingKey = [];
    const keyIds = new Map();
    const keys = [];
    const nameId = (start, end) => {
        const spelling = text.slice(start, end);
        let id = spellingIds.get(spelling);
        if (id === undefined) {
            id = spellings.length;
            spellingIds.set(spelling, id);
            spellings.push(spelling);
            const key = spelling.toLowerCase();
            let keyId = keyIds.get(key);
            if (keyId === undefined) {
                keyId = keys.length;
                keyIds.set(key, keyId);
                keys.push(key);
            }
            spellingKey.push(keyId);
        }
        return id;
    };

    // Pass 1: scan into a flat event list, and learn which names are ever
    // closed and which are declared EMPTY.
    let events = new Int32Array(1 << 16);
    let count = 0;
    const emit = (type, start, nameStart, nameEnd, end, id) => {
        if (count + EVENT_SIZE > events.length) {
            const grown = new Int32Array(events.length * 2);
            grown.set(events);
            events = grown;
        }
        events[count] = type;
        events[count + 1] = start;
        events[count + 2] = nameStart;
        events[count + 3] = nameEnd;
        events[count + 4] = end;
        events[count + 5] = id;
        count += EVENT_SIZE;
    };
    const closedKeys = new Set();
    const declaredEmpty = new Set();
    const blocks = [];
    const sections = [];
    scan(text, {
        startTag(start, nameStart, nameEnd, end, selfClosing) {
            emit(selfClosing ? START_SELF_CLOSING : START, start, nameStart, nameEnd, end, nameId(nameStart, nameEnd));
        },
        endTag(start, nameStart, nameEnd, end) {
            const id = nameId(nameStart, nameEnd);
            closedKeys.add(spellingKey[id]);
            emit(END, start, nameStart, nameEnd, end, id);
        },
        emptyStartTag(start, end) {
            emit(EMPTY_START, start, start + 1, start + 1, end, -1);
        },
        emptyEndTag(start, end) {
            emit(EMPTY_END, start, start + 2, start + 2, end, -1);
        },
        comment(start, end) {
            blocks.push({ start, end, kind: 'comment' });
        },
        elementDeclaration(names, isEmpty) {
            if (isEmpty) for (const n of names) declaredEmpty.add(n.toLowerCase());
        },
        markedSectionStart(start) {
            sections.push(start);
        },
        markedSectionEnd(start, end) {
            const open = sections.pop();
            if (open !== undefined) blocks.push({ start: open, end, kind: 'section' });
        },
        skippedSection(start, end) {
            blocks.push({ start, end, kind: 'section' });
        },
    });
    // Marked sections left open run to the end of the document.
    for (const open of sections) blocks.push({ start: open, end: text.length, kind: 'section' });

    const kinds = keys.map((key, keyId) => {
        if (emptyElements.has(key) || (infer && declaredEmpty.has(key))) return EMPTY;
        return infer && !closedKeys.has(keyId) ? INFERRED_EMPTY : NORMAL;
    });

    // Pass 2: build the tree.
    const roots = [];
    const stack = [];
    // Number of open elements per key id, so an orphan end tag is rejected
    // without walking the stack.
    const openCount = new Int32Array(keys.length);
    let lastEnded = null;
    // The latest element taken as empty only because its name is never closed
    // by name. An empty end tag `</>` right after it closes it instead.
    let lastInferred = null;
    let elementCount = 0;

    const pop = () => {
        const node = stack.pop();
        openCount[node.keyId]--;
        lastEnded = node;
        return node;
    };
    // Closes the elements above `depth` whose end tag was omitted. They end at
    // the last non-blank character before `offset`, so their range (and the
    // folding region) does not reach into the line of the tag that closes them.
    const closeImplicitly = (depth, offset) => {
        if (stack.length <= depth) return;
        let p = offset;
        while (p > 0 && isWs(text.charCodeAt(p - 1))) p--;
        while (stack.length > depth) {
            const node = pop();
            node.end = Math.max(p, node.tagEnd);
            node.implicitEnd = true;
        }
    };

    for (let i = 0; i < count; i += EVENT_SIZE) {
        const type = events[i];
        const start = events[i + 1];
        const end = events[i + 4];
        if (type === START || type === START_SELF_CLOSING || type === EMPTY_START) {
            let name;
            let keyId;
            if (type === EMPTY_START) {
                const ref = lastEnded || stack[stack.length - 1];
                if (!ref) continue;
                name = ref.name;
                keyId = ref.keyId;
            } else {
                const id = events[i + 5];
                name = spellings[id];
                keyId = spellingKey[id];
            }
            const kind = type === START_SELF_CLOSING ? EMPTY : kinds[keyId];
            const parent = stack.length ? stack[stack.length - 1] : null;
            const node = new SgmlElement(name, keys[keyId], keyId, start, events[i + 2], events[i + 3], end, parent);
            if (parent) appendChild(parent, node);
            else roots.push(node);
            elementCount++;
            if (kind === NORMAL) {
                stack.push(node);
                openCount[keyId]++;
            } else {
                lastEnded = node;
                if (kind === INFERRED_EMPTY) lastInferred = node;
            }
        } else if (type === END) {
            const keyId = spellingKey[events[i + 5]];
            if (!openCount[keyId]) continue;
            let depth = stack.length - 1;
            while (stack[depth].keyId !== keyId) depth--;
            closeImplicitly(depth + 1, start);
            const node = pop();
            node.end = end;
            node.endTagStart = start;
        } else {
            const top = stack.length ? stack[stack.length - 1] : null;
            if (lastInferred && lastInferred.parent === top) {
                // `<item>a<b>x</b></>`: item was not empty after all; the
                // elements that followed it become its children.
                const node = lastInferred;
                const siblings = top ? top.children : roots;
                const moved = siblings.splice(siblings.indexOf(node) + 1);
                for (const child of moved) {
                    child.parent = node;
                    appendChild(node, child);
                }
                node.end = end;
                node.endTagStart = start;
                lastEnded = node;
                lastInferred = null;
            } else if (top) {
                const node = pop();
                node.end = end;
                node.endTagStart = start;
            }
        }
    }
    closeImplicitly(0, text.length);
    return { roots, blocks, elementCount };
}

function lastStartingAtOrBefore(list, offset) {
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].start <= offset) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found;
}

/**
 * Innermost element containing `offset`. The position right after an end tag
 * is outside the element; the position right after the last character of an
 * element whose end tag was omitted is still inside it.
 * @returns {SgmlElement | null}
 */
function elementAt(roots, offset) {
    let list = roots;
    let found = null;
    for (;;) {
        const i = lastStartingAtOrBefore(list, offset);
        if (i < 0) return found;
        const node = list[i];
        const inside = offset < node.end || (offset === node.end && node.implicitEnd);
        if (!inside) return found;
        found = node;
        list = node.children;
    }
}

/** The element and its ancestors, outermost first. */
function ancestry(node) {
    const chain = [];
    for (let n = node; n; n = n.parent) chain.push(n);
    return chain.reverse();
}

/**
 * `/dmodule/content/para`, or with `indexed` an XPath-style path where a step
 * gets a 1-based position when its parent has several children of that name:
 * `/dmodule/content/para[3]`.
 */
function elementPath(node, roots, indexed) {
    let path = '';
    for (const n of ancestry(node)) {
        path += '/' + n.name;
        if (!indexed) continue;
        const siblings = n.parent ? n.parent.children : roots;
        let position = 0;
        let total = 0;
        for (const s of siblings) {
            if (s.key !== n.key) continue;
            total++;
            if (s === n) position = total;
        }
        if (total > 1) path += `[${position}]`;
    }
    return path;
}

const MAX_DETAIL = 80;

/**
 * Short description of a start tag's attributes: the value of `id` when
 * present, otherwise the first attribute (`name=value`, or the value alone for
 * a minimized attribute). Empty when the tag has no attributes.
 */
function attributeDetail(text, node) {
    let end = node.tagEnd;
    if (text.charCodeAt(end - 1) === 0x3e) end--;
    if (text.charCodeAt(end - 1) === 0x2f) end--;
    let i = node.nameEnd;
    let first = '';
    while (i < end) {
        while (i < end && isWs(text.charCodeAt(i))) i++;
        if (i >= end) break;
        const nameStart = i;
        while (i < end && !isWs(text.charCodeAt(i)) && text[i] !== '=' && text[i] !== '"' && text[i] !== "'") i++;
        const name = text.slice(nameStart, i);
        let j = i;
        while (j < end && isWs(text.charCodeAt(j))) j++;
        let value = null;
        if (text[j] === '=') {
            j++;
            while (j < end && isWs(text.charCodeAt(j))) j++;
            const q = text[j];
            if (q === '"' || q === "'") {
                const close = text.indexOf(q, j + 1);
                const valueEnd = close === -1 || close > end ? end : close;
                value = text.slice(j + 1, valueEnd);
                i = valueEnd + 1;
            } else {
                const valueStart = j;
                while (j < end && !isWs(text.charCodeAt(j))) j++;
                value = text.slice(valueStart, j);
                i = j;
            }
        } else if (!name) {
            // A stray quote or '='.
            i++;
            continue;
        }
        if (value !== null && name.toLowerCase() === 'id') return truncate(value);
        if (!first) first = value === null ? name : `${name}=${value}`;
    }
    return truncate(first);
}

function truncate(s) {
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > MAX_DETAIL ? s.slice(0, MAX_DETAIL - 1) + '…' : s;
}

module.exports = { parse, elementAt, ancestry, elementPath, attributeDetail, SgmlElement };
