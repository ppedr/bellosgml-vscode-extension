# Changelog

## 1.1.0

- Syntax highlighting rewritten to cover SGML: unquoted and minimized attributes, SGML processing
  instructions, `<!DOCTYPE>` internal subsets, comments inside declarations, entity references without `;`,
  parameter entities, marked sections (`CDATA`, `RCDATA`, `IGNORE`, `INCLUDE`, `%param;`) and the empty tags
  `<>` and `</>`. Colours match XML in every theme.
- `.sgml` and `.sgm` files open as SGML and use this extension as their default formatter.
- **Format Document** (`Shift+Alt+F`) now pretty-prints the open document in place, up to
  `bellosgml.largeFileSizeMB`. Larger documents are left alone and a `*.bello.sgml` copy is offered.
  `Shift+Alt+F` no longer writes a copy; use the right-click menu for that.
- Element hierarchy in breadcrumbs, Outline and Sticky Scroll, folding by element, an element path in the
  status bar and the **SGML: Copy Element Path** command, all handling omitted end tags. New settings:
  `sgml.emptyElements`, `sgml.hierarchy.inferEmptyElements`, `sgml.hierarchy.maxFileSizeMB` (default and
  maximum 50, the size above which VS Code does not give documents to extensions) and
  `sgml.hierarchy.maxSymbols`.
- Editing: `<`, `[` and quotes close automatically, Enter after a start tag indents, and double-click selects
  names with `-` and `.`.

## 1.0.0

- First release: pretty-prints SGML files to a `*.bello.sgml` copy with `Shift+Alt+F` or from the
  right-click menu, with progress, cancellation, and support for very large files.
