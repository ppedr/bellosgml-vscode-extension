# Development

Notes for working on the extension. This file is not included in the package (`.vscodeignore`); the README
is for end users.

```sh
npm install                                           # test tools only; the extension has no dependencies
npm test                                              # unit tests, reference cases, XML colour equivalence, grammar snapshots
npm run test:integration                              # inside a downloaded VS Code (cached in .vscode-test/)
MOCHA_GREP="hierarchy" npm run test:integration       # only the matching integration tests
npm run bench -- 20                                   # parse time of a synthetic 20 MB manual
npm run compare -- <reference-tool> file.sgml         # compare with a reference pretty-printer on real files
npm run package                                       # build bellosgml-<version>.vsix with vsce
code --install-extension bellosgml-1.1.0.vsix
```

There are no runtime dependencies and no build step. Packaging uses `@vscode/vsce` installed globally
(`npm install -g @vscode/vsce`).

- `extension.js`: the copy command, Format Document, progress notification, output naming and settings.
- `lib/formatter.js`: the pretty-print algorithm.
- `lib/worker.js`: runs the formatter on a worker thread and reports progress.
- `lib/fileio.js`: encoding detection and writing through a temporary file.
- `lib/sgml-scanner.js`: single-pass scanner reporting tags, comments, PIs, declarations and marked sections
  with offsets.
- `lib/sgml-structure.js`: the element tree built from the scanner, element at an offset, paths.
- `lib/line-index.js`: offset to line conversion.
- `lib/hierarchy.js`: document symbols, folding, status bar and Copy Element Path, sharing one parse per
  document version.
- `syntaxes/sgml.tmLanguage.json`: the TextMate grammar.

Tests: `test/*.test.js` run with `node --test`; grammar snapshots are `test/fixtures/grammar/*.sgml.snap`
(regenerate with `npx vscode-tmgrammar-snap -u "test/fixtures/grammar/*.sgml"` and review the diff);
`test/integration/` runs in VS Code with `@vscode/test-electron`.

## Large documents

Replacing a large document through an editor edit runs on the window's UI thread (buffer rebuild, undo
history, diff, tokenization) and can freeze VS Code for minutes: a 42 MB document becomes 71 MB and 2 million
lines. That is why Format Document only edits documents up to `bellosgml.largeFileSizeMB` and offers the
`*.bello.sgml` copy above that, and why the copy opens automatically only below the same limit. For the same
reason `<`/`>` are not declared as brackets in `language-configuration.json` (they still auto-close).

The element tree is parsed on the extension host thread, once per document version, and shared by the
symbol and folding providers, the status bar and the command. On a 20 MB synthetic manual (775,000
elements) the parse takes about 300 ms in Node and the first symbols request about 800 ms in VS Code; on
the real 42 MB AOM manual (870,000 elements) about 600 ms and 1.2 s. Time a real file with
`npm run bench -- file.sgml`, or inside VS Code with `SGML_SAMPLE=file.sgml npm run test:integration`.
Turning 775,000 elements into document symbols and sending them to the window takes about 7 seconds, so
`symbolsFor` stops at the deepest level that keeps the total within `sgml.hierarchy.maxSymbols`. Folding does
the same with `editor.foldingMaximumRegions`, which VS Code applies anyway. VS Code caches symbols per
document version, so the providers are registered again when an `sgml.*` setting changes.

## Grammar

Scopes follow VS Code's XML grammar with `.sgml` instead of `.xml`. Light+ has rules for
`string.quoted.double.xml`, `string.quoted.single.xml` and `string.unquoted.cdata.xml` only, so those tokens
also carry the XML scope as their innermost scope. `test/grammar-theme.test.js` tokenizes the same text with
both grammars, colours it with Dark+ and Light+ (theme files in `test/fixtures/vscode/`), and compares the
colour of every visible character.

## Element hierarchy rules

Without a DTD:

- `</x>` closes every element opened after the innermost open `x`; `</x>` with no open `x` is ignored.
- `</>` closes the current element; `<>` reopens the most recently ended element.
- Elements still open at the end of the document end there. An element closed implicitly ends at the last
  non-blank character before the tag that closed it, so its range and folding region stay off that line.
- Empty elements: `sgml.emptyElements`, `<x/>`, `<!ELEMENT x - O EMPTY>` in the internal subset, and names
  that never have an end tag in the document. Text after such an element does not make it a container:
  the real AOM manual has `<REVST>text<REVEND>` milestones, and in it every element with content is closed
  explicitly (the only names never closed are `COLSPEC`, `REVST`, `REVEND` and `DELETED`). A rule that
  treated "never closed but followed by text" as an omitted end tag put text and siblings inside `REVST`.
- `</>` right after an element taken as empty this way closes that element instead, and the elements after
  it become its children.
- Comments, PIs, declarations and `CDATA`/`RCDATA`/`IGNORE` marked sections are skipped; `INCLUDE`, `TEMP`
  and `%param;` sections are parsed as markup.

Known limit: a name that is closed in some places and not in others nests (`<p>a<p>b</p>` gives `p > p`),
because only a DTD can tell where the first `p` ends.

## Formatting rules

1. Each physical line is trimmed and empty lines are dropped. Lines are joined with a space until one ends
   with `>`.
2. Each tag and each piece of text becomes one line. A tag ends at the first `>` (quotes do not protect `>`).
   Adjacent text is joined with a space.
3. Text longer than 80 characters is wrapped at the last space at or before column 80, not counting
   indentation. The space stays at the end of the wrapped line. A longer word is never cut.
4. Start tag attributes are sorted with a plain string compare (uppercase before lowercase). A space only
   separates attributes after a complete `name="value"`, so `CHAR=" "` and values with spaces stay intact.
   End tags, `<!...>` and `<?...>` are left as they are.
5. Indentation is computed from the end of the document backwards. An element only indents its content if it
   has an end tag, so `COLSPEC`, `REVST` and similar elements stay at their siblings' level. A start tag is
   matched to its end tag by looking for `"<" + name` as a substring.

Edge cases:

- Whitespace includes NBSP, matched as a whole character, so UTF-8 characters such as `à` (`C3 A0`) and `°`
  (`C2 B0`) at the edges of a text are never damaged.
- The last token of the file is handled like every other one (attributes sorted, text wrapped).
- Trailing text that does not end with `>` is kept.
- Indentation never goes below zero, even with unbalanced tags such as `<A><AB>x</A>`.
- Text width is counted in characters, not bytes.
- Files are read as UTF-8 when valid, otherwise as Latin-1, and written back in the same encoding, keeping the
  BOM.
