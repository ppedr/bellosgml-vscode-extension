# Development

Notes for working on the extension. This file is not included in the package (`.vscodeignore`); the README
is for end users.

```sh
npm test                                              # unit tests and reference cases
npm run compare -- <reference-tool> file.sgml         # compare with a reference pretty-printer on real files
npm run package                                       # build bellosgml-<version>.vsix with vsce
code --install-extension bellosgml-1.0.0.vsix
```

There are no runtime dependencies and no build step. Packaging uses `@vscode/vsce` installed globally
(`npm install -g @vscode/vsce`).

- `extension.js`: the command, progress notification, output naming and settings.
- `lib/formatter.js`: the pretty-print algorithm.
- `lib/worker.js`: runs the formatter on a worker thread and reports progress.
- `lib/fileio.js`: encoding detection and writing through a temporary file.

## Why the extension only writes copies

Replacing a large document through an editor edit runs on the window's UI thread (buffer rebuild, undo
history, diff, tokenization) and can freeze VS Code for minutes: a 42 MB document becomes 71 MB and 2 million
lines. That is why the only command writes `*.bello.sgml` to disk, and the copy opens automatically only below
`bellosgml.largeFileSizeMB`. For the same reason `<`/`>` are not declared as brackets in
`language-configuration.json`.

`Shift+Alt+F` stays bound in `.bello` copies too: otherwise VS Code falls back to the built-in Format Document
and shows "There is no formatter for 'sgml' files installed".

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
