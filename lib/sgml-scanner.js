'use strict';

// Single-pass SGML scanner. It walks the text once with indexOf/charCodeAt (no
// regular expressions over the document) and reports markup to a sink with
// character offsets. It never throws: anything it does not recognise is text,
// and an unterminated construct ends at the end of the document (or, for tags,
// before the next '<', which is also how SGML reads an unclosed tag).
//
// Sink methods (all optional except the tag ones):
//   startTag(start, nameStart, nameEnd, end, selfClosing)   <name ...>  <name/>
//   endTag(start, nameStart, nameEnd, end)                  </name>
//   emptyStartTag(start, end) / emptyEndTag(start, end)     <>  </>
//   comment(start, end)                                     <!-- ... -->
//   pi(start, end)                                          <? ... >
//   declaration(start, end)                                 <!DOCTYPE ...>, <!ENTITY ...>, ...
//   elementDeclaration(names, isEmpty)                      from <!ELEMENT ...>
//   markedSectionStart(start, bodyStart) / markedSectionEnd(start, end)
//                                                           INCLUDE, TEMP, %param; sections, whose content is markup
//   skippedSection(start, end, kind)                        CDATA, RCDATA and IGNORE sections ('cdata' | 'rcdata' | 'ignore')

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const BANG = 0x21;
const QMARK = 0x3f;
const DASH = 0x2d;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const DQUOTE = 0x22;
const SQUOTE = 0x27;
const PERCENT = 0x25;
const SEMICOLON = 0x3b;

function isWs(c) {
    return c === 0x20 || (c >= 0x09 && c <= 0x0d);
}

// ASCII letters, '_' and any non-ASCII character start a name; digits, '-',
// '.' and ':' may follow.
function isNameStart(c) {
    return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || c >= 0x80;
}

function isNameChar(c) {
    return isNameStart(c) || (c >= 0x30 && c <= 0x39) || c === DASH || c === 0x2e || c === 0x3a;
}

function nameEnd(text, i) {
    const len = text.length;
    while (i < len && isNameChar(text.charCodeAt(i))) i++;
    return i;
}

function skipWs(text, i) {
    const len = text.length;
    while (i < len && isWs(text.charCodeAt(i))) i++;
    return i;
}

const noop = () => {};

function scan(text, sink) {
    const len = text.length;
    const comment = sink.comment || noop;
    const pi = sink.pi || noop;
    const declaration = sink.declaration || noop;
    const elementDeclaration = sink.elementDeclaration || noop;
    const markedSectionStart = sink.markedSectionStart || noop;
    const markedSectionEnd = sink.markedSectionEnd || noop;
    const skippedSection = sink.skippedSection || noop;
    const emptyStartTag = sink.emptyStartTag || noop;
    const emptyEndTag = sink.emptyEndTag || noop;

    // Status keywords of "<![ ... [" starting at i (just after "<!["). Returns
    // the kind and the offset after '[', or null when this is not a marked
    // section start.
    function markedSectionStatus(i) {
        let ignore = false;
        let cdata = false;
        let rcdata = false;
        for (;;) {
            i = skipWs(text, i);
            if (i >= len) return null;
            const c = text.charCodeAt(i);
            if (c === LBRACKET) break;
            if (c === PERCENT) {
                i = nameEnd(text, i + 1);
                if (i < len && text.charCodeAt(i) === SEMICOLON) i++;
            } else if (isNameStart(c)) {
                const end = nameEnd(text, i);
                const word = text.slice(i, end).toUpperCase();
                if (word === 'IGNORE') ignore = true;
                else if (word === 'CDATA') cdata = true;
                else if (word === 'RCDATA') rcdata = true;
                i = end;
            } else {
                return null;
            }
        }
        const kind = ignore ? 'ignore' : cdata ? 'cdata' : rcdata ? 'rcdata' : 'include';
        return { kind, bodyStart: i + 1 };
    }

    // End of an IGNORE section whose body starts at i: nested "<![" ... "]]>"
    // pairs are counted, nothing else is recognised.
    function ignoredSectionEnd(i) {
        let depth = 1;
        let open = text.indexOf('<![', i);
        let close = text.indexOf(']]>', i);
        while (close !== -1) {
            if (open !== -1 && open < close) {
                depth++;
                i = open + 3;
                open = text.indexOf('<![', i);
            } else {
                depth--;
                i = close + 3;
                if (depth === 0) return i;
                close = text.indexOf(']]>', i);
                if (open !== -1 && open < i) open = text.indexOf('<![', i);
            }
        }
        return len;
    }

    // Offset after a quoted literal starting at i. An unterminated quote is
    // taken as a stray character so it cannot swallow the rest of the document.
    function skipQuoted(i) {
        const q = text.indexOf(text[i], i + 1);
        return q === -1 ? i + 1 : q + 1;
    }

    // Offset after "-- ... --" starting at i (or just after a lone "--").
    function skipDeclComment(i) {
        const e = text.indexOf('--', i + 2);
        return e === -1 ? i + 2 : e + 2;
    }

    // "<!ELEMENT name-or-group [minimization] content ...>": reports the names
    // and whether the declared content is EMPTY.
    function reportElementDeclaration(bodyStart, bodyEnd) {
        let body = '';
        for (let i = bodyStart; i < bodyEnd;) {
            const c = text.charCodeAt(i);
            if (c === DASH && text.charCodeAt(i + 1) === DASH) {
                const e = text.indexOf('--', i + 2);
                if (e === -1 || e >= bodyEnd) break;
                body += ' ';
                i = e + 2;
            } else {
                body += text[i++];
            }
        }
        body = body.trim();
        let names;
        let rest;
        if (body[0] === '(') {
            const close = body.indexOf(')');
            if (close === -1) return;
            names = body.slice(1, close).split(/[\s|,&]+/).filter(Boolean);
            rest = body.slice(close + 1);
        } else {
            const parts = body.split(/\s+/);
            names = [parts.shift()].filter(Boolean);
            rest = parts.join(' ');
        }
        // A parameter entity name group cannot be resolved without the DTD.
        if (!names.length || names.some((n) => n[0] === '%')) return;
        const tokens = rest.split(/\s+/).filter(Boolean);
        let k = 0;
        // Omitted tag minimization ("- O", "O O"), when the SGML declaration enables it.
        while (k < tokens.length && k < 2 && /^[-Oo]$/.test(tokens[k])) k++;
        elementDeclaration(names, k < tokens.length && tokens[k].toUpperCase() === 'EMPTY');
    }

    // Internal DTD subset starting just after '['. Returns the offset after
    // the closing ']'.
    function scanSubset(i) {
        let msDepth = 0;
        while (i < len) {
            const c = text.charCodeAt(i);
            if (c === LT) {
                const c1 = text.charCodeAt(i + 1);
                if (c1 === BANG) {
                    if (text.startsWith('<!--', i)) {
                        const e = text.indexOf('-->', i + 4);
                        const end = e === -1 ? len : e + 3;
                        comment(i, end);
                        i = end;
                    } else if (text.charCodeAt(i + 2) === LBRACKET) {
                        const status = markedSectionStatus(i + 3);
                        if (!status) {
                            i += 3;
                        } else if (status.kind === 'include') {
                            msDepth++;
                            i = status.bodyStart;
                        } else {
                            const end = status.kind === 'ignore' ? ignoredSectionEnd(status.bodyStart) : endOf(']]>', status.bodyStart);
                            skippedSection(i, end, status.kind);
                            i = end;
                        }
                    } else {
                        i = scanDeclaration(i, false);
                    }
                } else if (c1 === QMARK) {
                    const end = endOf('>', i + 2);
                    pi(i, end);
                    i = end;
                } else {
                    i++;
                }
            } else if (c === RBRACKET) {
                if (msDepth > 0 && text.startsWith(']]>', i)) {
                    msDepth--;
                    i += 3;
                } else {
                    return i + 1;
                }
            } else if (c === DQUOTE || c === SQUOTE) {
                i = skipQuoted(i);
            } else {
                i++;
            }
        }
        return len;
    }

    function endOf(delimiter, from) {
        const e = text.indexOf(delimiter, from);
        return e === -1 ? len : e + delimiter.length;
    }

    // "<!keyword ...>" starting at start. Quotes and "-- --" comments are
    // skipped; a DOCTYPE's '[' opens the internal subset; a stray '<' ends an
    // unclosed declaration.
    function scanDeclaration(start, allowSubset) {
        const kwStart = start + 2;
        const kwEnd = nameEnd(text, kwStart);
        const keyword = text.slice(kwStart, kwEnd).toUpperCase();
        const subset = allowSubset && keyword === 'DOCTYPE';
        let i = kwEnd;
        let end = len;
        while (i < len) {
            const c = text.charCodeAt(i);
            if (c === GT) {
                end = i + 1;
                break;
            } else if (c === LT) {
                end = i;
                break;
            } else if (c === DQUOTE || c === SQUOTE) {
                i = skipQuoted(i);
            } else if (c === DASH && text.charCodeAt(i + 1) === DASH) {
                i = skipDeclComment(i);
            } else if (c === LBRACKET && subset) {
                i = scanSubset(i + 1);
            } else {
                i++;
            }
        }
        if (keyword === 'ELEMENT') reportElementDeclaration(kwEnd, end === len ? len : end - 1);
        declaration(start, end);
        return end;
    }

    // Open INCLUDE-like marked sections in the content, and the cached offset
    // of the next "]]>" (-2: not looked up yet, -1: there is none).
    let msDepth = 0;
    let msClose = -2;
    let pos = 0;
    while (pos < len) {
        const lt = text.indexOf('<', pos);
        if (msDepth > 0) {
            if (msClose !== -1 && msClose < pos) msClose = text.indexOf(']]>', pos);
            if (msClose !== -1 && (lt === -1 || msClose < lt)) {
                markedSectionEnd(msClose, msClose + 3);
                msDepth--;
                pos = msClose + 3;
                continue;
            }
        }
        if (lt === -1) break;
        const c1 = text.charCodeAt(lt + 1);

        if (isNameStart(c1)) {
            const ne = nameEnd(text, lt + 1);
            let i = ne;
            let end = len;
            let selfClosing = false;
            // A quote only opens a literal right after '=' (spaces allowed), so
            // an apostrophe in an unquoted value such as title=don't is just a
            // character.
            let afterEq = false;
            while (i < len) {
                const c = text.charCodeAt(i);
                if (c === GT) {
                    end = i + 1;
                    break;
                } else if (c === LT) {
                    end = i;
                    break;
                } else if (c === SLASH && text.charCodeAt(i + 1) === GT) {
                    selfClosing = true;
                    end = i + 2;
                    break;
                } else if ((c === DQUOTE || c === SQUOTE) && afterEq) {
                    i = skipQuoted(i);
                    afterEq = false;
                } else {
                    if (c === 0x3d) afterEq = true;
                    else if (!isWs(c)) afterEq = false;
                    i++;
                }
            }
            sink.startTag(lt, lt + 1, ne, end, selfClosing);
            pos = end;
        } else if (c1 === SLASH) {
            const c2 = text.charCodeAt(lt + 2);
            if (c2 === GT) {
                emptyEndTag(lt, lt + 3);
                pos = lt + 3;
            } else if (isNameStart(c2)) {
                const ne = nameEnd(text, lt + 2);
                let i = ne;
                while (i < len) {
                    const c = text.charCodeAt(i);
                    if (c === GT) {
                        i++;
                        break;
                    }
                    if (c === LT) break;
                    i++;
                }
                sink.endTag(lt, lt + 2, ne, i);
                pos = i;
            } else {
                pos = lt + 1;
            }
        } else if (c1 === GT) {
            emptyStartTag(lt, lt + 2);
            pos = lt + 2;
        } else if (c1 === BANG) {
            if (text.startsWith('--', lt + 2)) {
                const end = endOf('-->', lt + 4);
                comment(lt, end);
                pos = end;
            } else if (text.charCodeAt(lt + 2) === LBRACKET) {
                const status = markedSectionStatus(lt + 3);
                if (!status) {
                    pos = lt + 1;
                } else if (status.kind === 'include') {
                    markedSectionStart(lt, status.bodyStart);
                    msDepth++;
                    pos = status.bodyStart;
                } else {
                    const end = status.kind === 'ignore' ? ignoredSectionEnd(status.bodyStart) : endOf(']]>', status.bodyStart);
                    skippedSection(lt, end, status.kind);
                    pos = end;
                }
            } else if (isNameStart(text.charCodeAt(lt + 2))) {
                pos = scanDeclaration(lt, true);
            } else {
                // "<!>" and other oddities.
                const end = endOf('>', lt + 2);
                declaration(lt, end);
                pos = end;
            }
        } else if (c1 === QMARK) {
            const end = endOf('>', lt + 2);
            pi(lt, end);
            pos = end;
        } else {
            pos = lt + 1;
        }
    }
}

module.exports = { scan, isWs, isNameStart, isNameChar };
