# Images for the Marketplace page

The extension's README references these files with relative paths (`images/<name>`). `vsce` turns them
into links to this folder on GitHub, so an image only appears on the Marketplace page after it has been
committed and pushed. `images/**` is in `.vscodeignore`, so none of this goes into the `.vsix`.

Formats: PNG or GIF only (the Marketplace does not accept SVG in the README). GIFs up to ~5 MB.

| File | Status | In the README |
|---|---|---|
| `bello.gif` | done | main image, under the first paragraph |
| `hierarchy.png` | to capture | commented out under **Element hierarchy** |
| `outline.png` | to capture | commented out under **Element hierarchy** |
| `copy-path.png` | to capture | commented out under **Element hierarchy** |
| `highlighting.png` | to capture | commented out under **Syntax highlighting** |

When a capture is ready, save it here with that name and remove the `<!--` and `-->` around its line in
the README.

## `bello.gif` (done)

- **Format**: GIF, 862×957, 7.6 s, loop. Simulated VS Code window (Dark+), drawn by a script.
- **Source**: `images/bello.sgml`, a messy file with original lyrics ("Canção do Bello").
- **Regenerate** (Python 3 with Pillow, and Node.js), from the repository root:
  ```
  python scripts/render-gif.py images/bello.sgml -o images/bello.gif
  ```
  The "after" frame is the real output of `lib/formatter.js`. Add `--frames <dir>` to check each frame as
  PNG.

## Screenshots to capture

Common setup for every capture:
- VS Code with the **Dark+** theme, zoom 100%, a window of about 1280×800.
- Hide what is not part of the shot: close the panel (`Ctrl+J`), and keep the Activity Bar and minimap
  only where noted.
- Use `test/fixtures/` or a fictional file. No content from customers' manuals.
- Crop to the relevant area and save as PNG.

### `hierarchy.png`

- **Size**: about 1200×700.
- **On screen**: a long, nested document with breadcrumbs, Sticky Scroll and the element path in the status
  bar, all at the same time.
- **Cursor**: on a text line at least four levels deep, for example inside a `PARA` in a `NOTE` inside a
  `SECTION`.
- **Steps**:
  1. Turn on Sticky Scroll (`editor.stickyScroll.enabled`) and breadcrumbs (`breadcrumbs.enabled`).
  2. Open the document and format it with `Shift+Alt+F`, so the nesting is visible.
  3. Put the cursor on the deep line and scroll down a little until Sticky Scroll shows two or three
     enclosing elements.
  4. Check that the breadcrumbs and the status bar show the same path, and take the screenshot.

### `outline.png`

- **Size**: about 1200×700 (editor plus side bar).
- **On screen**: the Outline view open with the element tree expanded two or three levels, and the `id`
  (or first attribute) next to each name.
- **Cursor**: on an element that has an `id`, so it is highlighted in the Outline.
- **Steps**:
  1. Use a document whose elements have `id` or `KEY` attributes.
  2. Open the Explorer (`Ctrl+Shift+E`) and expand **Outline** (collapse the other sections).
  3. Expand a few levels and click an element so the editor and the Outline match.
  4. Take the screenshot with the editor and the side bar.

### `copy-path.png`

- **Size**: about 1000×400.
- **On screen**: the quick pick of **SGML: Copy Element Path** with its two options, the simple path and the
  XPath with positions (`/dmodule/content/para[3]`).
- **Cursor**: on an element that has siblings with the same name, so the XPath shows a position greater
  than 1.
- **Steps**:
  1. Put the cursor on the element.
  2. Open the Command Palette (`Ctrl+Shift+P`) and run **SGML: Copy Element Path**.
  3. With the two options visible, take the screenshot.

### `highlighting.png`

- **Size**: about 1200×500.
- **On screen**: the same snippet open side by side as `.sgml` and `.xml`, with the same colours. The
  snippet should also have something XML does not have (an unquoted value or a marked section) on the SGML
  side.
- **Cursor**: anywhere outside the snippet, so the current line highlight does not change any colour.
- **Steps**:
  1. Create `demo.sgml` and `demo.xml` with the same well-formed snippet.
  2. Add an SGML-only line to `demo.sgml`, such as `<para id=p001>` or `<![ %local; [ ... ]]>`.
  3. Open them side by side (`Ctrl+\`), with no selection.
  4. Take the screenshot of both editors.
