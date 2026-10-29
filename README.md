# Bello SGML Pretty Printer

Turn hard-to-read SGML into a clean, indented document, one tag or text block per line. It works with
files of any size, including documents with tens of megabytes, without freezing VS Code.

Supports `.sgml` and `.sgm` files.

## Features

- **Pretty-printed copy**: the result is written next to the original as `name.bello.sgml`. The original file
  is never changed.
- **No overwriting**: if `name.bello.sgml` already exists, the copy is saved as `name.bello.1.sgml`,
  `name.bello.2.sgml`, and so on.
- **Large files**: formatting runs in the background. A notification shows the progress and the estimated
  time left, and you can cancel at any time. A 40 MB document takes a few seconds.
- **Indentation**: each element's content is indented one level. Elements without an end tag (such as
  `COLSPEC`) stay at the same level as their siblings.
- **Sorted attributes**: start tag attributes are sorted by name. Quoted values, including values with
  spaces, are kept as they are.
- **Text wrapping**: long text is wrapped at the last space before column 80. Words are never cut.
- **Clean whitespace**: blank lines are removed, and text split across several lines is joined.
- **Encoding preserved**: UTF-8 (with or without BOM) and Latin-1 files are written back in the same
  encoding.
- **Syntax highlighting** for SGML tags, attributes, comments, declarations and entities.

## Usage

Open an SGML file and press `Shift+Alt+F`, or right-click the file in the Explorer or in the editor and
choose **Pretty-print File on Disk to \*.bello.sgml**.

- Files up to 5 MB: the copy opens as soon as it is ready.
- Larger files: the copy is saved but not opened, because opening a very large file can make VS Code slow
  for a while. Click **Open** in the final notification to open it anyway.
- Unsaved changes: you are asked whether to save the file first or use the version on disk.
- Files that are already a copy (`*.bello.sgml`) do not offer the command, since they are already
  pretty-printed.

## Settings

| Setting | Default | Description |
|---|---|---|
| `bellosgml.indent` | `0` | `0` indents with one tab per level; `1` to `8` uses that many spaces. |
| `bellosgml.wrapWidth` | `80` | Column where long text is wrapped (indentation not counted). `0` disables wrapping. |
| `bellosgml.lineEnding` | `crlf` | Line ending of the copy: `crlf`, `lf`, or `keep` (same as the original). |
| `bellosgml.insertFinalNewline` | `false` | End the copy with a line break. |
| `bellosgml.largeFileSizeMB` | `5` | Copies of files up to this size open automatically. |
| `bellosgml.openLargeFileOutput` | `false` | Also open copies of files larger than `bellosgml.largeFileSizeMB`. |

Open the settings with `Ctrl+,` and search for **Bello SGML**.

## Installation

### From VSIX (manual)

1. Download `bellosgml-1.0.0.vsix`
2. In VS Code: `Extensions` → `...` (top right) → `Install from VSIX...`
3. Select the file and reload VS Code
