"""Renders the Marketplace pretty-print GIF: a simulated VS Code window (Dark+)
showing an SGML file, the Shift+Alt+F keys, then the file formatted by
lib/formatter.js. Nothing is recorded; every frame is drawn with Pillow.

Usage: python scripts/render-gif.py input.sgml [-o images/pretty-print.gif]
                                    [--indent 2] [--max-lines 60] [--frames DIR]
Needs Python 3 with Pillow and Node.js on the PATH.
"""
import argparse
import json
import os
import re
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Layout, in pixels.
MIN_W, MAX_W = 820, 1400
FONT_SIZE, LINE_H, UI_SIZE = 14, 19, 13
TITLE_H, TABS_H, CRUMB_H, STATUS_H = 30, 35, 22, 22
EDITOR_PAD = 4

# Frame durations, in milliseconds.
HOLD_BEFORE, PAUSE, KEY_STEP, KEYS_HOLD, HOLD_AFTER = 1800, 400, 250, 700, 4200

# Dark+ colours.
C = dict(
    bg='#1e1e1e', title='#3c3c3c', tabs='#252526', tab='#1e1e1e', status='#007acc',
    ln='#858585', ln_active='#c6c6c6', cur_line='#282828', cur_line_border='#303030',
    guide='#404040', caret='#aeafad', ui='#cccccc', crumb='#969696', icon='#e37933',
    punct='#808080', tag='#569cd6', attr='#9cdcfe', string='#ce9178', text='#d4d4d4',
    comment='#6a9955', entity='#569cd6', keyword='#569cd6',
    key_bg='#3a3d41', key_border='#6b6b6b',
)


def load_font(names, size):
    dirs = [os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts'),
            '/usr/share/fonts/truetype/dejavu', '/Library/Fonts', '/System/Library/Fonts']
    for name in names:
        for d in dirs:
            path = os.path.join(d, name)
            if os.path.exists(path):
                return ImageFont.truetype(path, size)
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    sys.exit('No usable font found among: ' + ', '.join(names))


MONO = load_font(['consola.ttf', 'DejaVuSansMono.ttf', 'Menlo.ttc'], FONT_SIZE)
UI = load_font(['segoeui.ttf', 'DejaVuSans.ttf', 'Helvetica.ttc'], UI_SIZE)
UI_BOLD = load_font(['segoeuib.ttf', 'DejaVuSans-Bold.ttf', 'Helvetica.ttc'], UI_SIZE)
CW = MONO.getlength('M')


def format_with_extension(path, indent):
    """Reads the file the way the extension does and returns (before, after)."""
    code = (
        "const fs=require('fs');"
        "const {decode}=require('./lib/fileio');"
        "const {format}=require('./lib/formatter');"
        "const {text}=decode(fs.readFileSync(process.argv[1]));"
        "const opts={indent:' '.repeat(+process.argv[2]),eol:'\\n'};"
        "process.stdout.write(JSON.stringify({before:text,after:format(text,opts)}));"
    )
    res = subprocess.run(['node', '-e', code, os.path.abspath(path), str(indent)],
                         cwd=ROOT, capture_output=True)
    if res.returncode:
        sys.exit(res.stderr.decode('utf-8', 'replace'))
    data = json.loads(res.stdout.decode('utf-8'))
    split = lambda s: s.replace('\r\n', '\n').replace('\r', '\n').rstrip('\n').split('\n')
    return split(data['before']), split(data['after'])


# --- Highlighting -----------------------------------------------------------
# A small scanner that carries its state across lines (comments and tags may
# span several). It colours what Dark+ colours in the XML grammar; it is not
# a parser.
NAME = re.compile(r'[A-Za-z_][-.\w]*')
ATTR = re.compile(r'([-.:\w]+)(\s*=\s*)([^\s"\'<>]+)?')
WORD = re.compile(r'[-.:\w%;#]+')
QUOTED = re.compile(r'"[^"]*"|\'[^\']*\'')
ENTITY = re.compile(r'&#?[\w.-]+;?')


def highlight(lines):
    state = None  # None, 'comment', 'tag' or 'decl'
    result = []
    for line in lines:
        spans, i, n = [], 0, len(line)
        while i < n:
            if state == 'comment':
                j = line.find('-->', i)
                end = n if j == -1 else j + 3
                spans.append((line[i:end], C['comment']))
                i = end
                if j != -1:
                    state = None
                continue
            if state in ('tag', 'decl'):
                if line.startswith('/>', i) or line[i] == '>':
                    k = 2 if line[i] == '/' else 1
                    spans.append((line[i:i + k], C['punct'])); i += k; state = None; continue
                if line[i] == '<':
                    state = None; continue  # unclosed tag ends before the next '<'
                if line[i] == '[' and state == 'decl':
                    spans.append(('[', C['punct'])); i += 1; state = None; continue
                m = QUOTED.match(line, i)
                if m:
                    spans.append((m.group(), C['string'])); i = m.end(); continue
                m = ATTR.match(line, i) if state == 'tag' else None
                if m:
                    spans.append((m.group(1), C['attr'])); spans.append((m.group(2), C['text']))
                    if m.group(3):
                        spans.append((m.group(3), C['string']))
                    i = m.end(); continue
                m = WORD.match(line, i)
                if m:
                    spans.append((m.group(), C['keyword'] if state == 'decl' else C['attr']))
                    i = m.end(); continue
                spans.append((line[i], C['text'])); i += 1; continue
            # Outside markup.
            if line.startswith('<!--', i):
                state = 'comment'; continue
            if line.startswith('<![', i):
                spans.append(('<![', C['punct'])); i += 3; state = 'decl'; continue
            if line.startswith(']]>', i):
                spans.append((']]>', C['punct'])); i += 3; continue
            if line.startswith('<!', i):
                spans.append(('<!', C['punct'])); i += 2
                m = NAME.match(line, i)
                if m:
                    spans.append((m.group(), C['keyword'])); i = m.end()
                state = 'decl'; continue
            if line.startswith('<>', i) or line.startswith('</>', i):
                k = 2 if line[i + 1] == '>' else 3
                spans.append((line[i:i + k], C['punct'])); i += k; continue
            if line[i] == '<':
                k = 2 if line.startswith('</', i) else 1
                spans.append((line[i:i + k], C['punct'])); i += k
                m = NAME.match(line, i)
                if m:
                    spans.append((m.group(), C['tag'])); i = m.end()
                state = 'tag'; continue
            m = ENTITY.match(line, i)
            if m and line[i] == '&':
                spans.append((m.group(), C['entity'])); i = m.end(); continue
            j = i + 1
            while j < n and line[j] not in '<&':
                j += 1
            spans.append((line[i:j], C['text'])); i = j
        result.append(spans)
    return result


# --- Cursor and breadcrumbs -------------------------------------------------
def indent_of(line):
    return len(line) - len(line.lstrip(' '))


def deepest_text_line(lines):
    """First text line at the deepest indentation: the most telling cursor spot."""
    best, depth = 0, -1
    for k, line in enumerate(lines):
        s = line.strip()
        if s and not s.startswith('<') and indent_of(line) > depth:
            best, depth = k, indent_of(line)
    return best


def ancestry(lines, row):
    """Element names enclosing `row`, read from the formatted indentation."""
    names, limit = [], indent_of(lines[row])
    for k in range(row - 1, -1, -1):
        line = lines[k]
        if line.strip() and indent_of(line) < limit:
            m = re.match(r'\s*<([A-Za-z_][-.\w]*)', line)
            if m:
                names.append(m.group(1))
            limit = indent_of(line)
            if limit == 0:
                break
    return names[::-1]


# --- Drawing ----------------------------------------------------------------
class Window:
    def __init__(self, filename, rows, width, indent):
        self.filename, self.rows, self.indent = filename, rows, indent
        self.gutter = int(CW * max(2, len(str(rows)))) + 30
        self.w = width
        self.editor_top = TITLE_H + TABS_H + CRUMB_H + EDITOR_PAD
        self.h = self.editor_top + rows * LINE_H + 8 + STATUS_H

    def draw(self, lines, spans, cursor, crumbs, dirty=False, message='', keys=None):
        im = Image.new('RGB', (self.w, self.h), C['bg'])
        d = ImageDraw.Draw(im, 'RGBA')
        w, h = self.w, self.h

        d.rectangle([0, 0, w, TITLE_H], fill=C['title'])
        for k, col in enumerate(['#ff5f57', '#febc2e', '#28c840']):
            d.ellipse([12 + k * 20, 9, 24 + k * 20, 21], fill=col)
        title = f'{self.filename} — demo — Visual Studio Code'
        d.text(((w - UI.getlength(title)) / 2, 7), title, font=UI, fill=C['ui'])

        y = TITLE_H
        tab_w = int(UI.getlength(self.filename)) + 70
        d.rectangle([0, y, w, y + TABS_H], fill=C['tabs'])
        d.rectangle([0, y, tab_w, y + TABS_H], fill=C['tab'])
        d.text((14, y + 9), '<>', font=UI_BOLD, fill=C['icon'])
        d.text((36, y + 9), self.filename, font=UI, fill='#ffffff')
        d.text((tab_w - 20, y + 7), '●' if dirty else '×', font=UI, fill=C['ui'])

        y += TABS_H
        d.text((16, y + 3), '  ›  '.join([self.filename] + crumbs), font=UI, fill=C['crumb'])

        row_c, col_c = cursor
        x0 = self.gutter + 10
        for r in range(min(self.rows, len(lines))):
            y = self.editor_top + r * LINE_H
            if r == row_c:
                d.rectangle([self.gutter, y, w, y + LINE_H - 1], fill=C['cur_line'], outline=C['cur_line_border'])
            num = str(r + 1)
            d.text((self.gutter - 14 - MONO.getlength(num), y + 1), num, font=MONO,
                   fill=C['ln_active'] if r == row_c else C['ln'])
            for g in range(0, indent_of(lines[r]), self.indent):
                gx = x0 + g * CW
                d.line([gx, y, gx, y + LINE_H], fill=C['guide'])
            x = x0
            for s, col in spans[r]:
                d.text((x, y + 1), s, font=MONO, fill=col)
                x += MONO.getlength(s)
            if r == row_c:
                cx = x0 + col_c * CW
                d.rectangle([cx, y + 1, cx + 1, y + LINE_H - 2], fill=C['caret'])

        d.rectangle([0, h - STATUS_H, w, h], fill=C['status'])
        d.text((10, h - STATUS_H + 3), 'main' + ('    ' + message if message else ''), font=UI, fill='white')
        right = f'Ln {row_c + 1}, Col {col_c + 1}    Spaces: {self.indent}    UTF-8    LF    SGML'
        d.text((w - 10 - UI.getlength(right), h - STATUS_H + 3), right, font=UI, fill='white')

        if keys:
            widths = [UI_BOLD.getlength(k) + 22 for k in keys]
            total = sum(widths) + 18 * (len(keys) - 1)
            x, y = (w - total) / 2, h / 2 - 30
            d.rounded_rectangle([x - 20, y - 16, x + total + 20, y + 46], 12,
                                fill=(0, 0, 0, 200), outline='#555555')
            for k, (key, kw) in enumerate(zip(keys, widths)):
                d.rounded_rectangle([x, y, x + kw, y + 30], 6, fill=C['key_bg'], outline=C['key_border'])
                d.line([x + 3, y + 30, x + kw - 3, y + 30], fill='#1a1a1a', width=2)
                d.text((x + 11, y + 6), key, font=UI_BOLD, fill='white')
                x += kw
                if k < len(keys) - 1:
                    d.text((x + 5, y + 5), '+', font=UI_BOLD, fill=C['ui'])
                    x += 18
        return im


def main():
    ap = argparse.ArgumentParser(description='Render the pretty-print GIF for an SGML file.')
    ap.add_argument('input')
    ap.add_argument('-o', '--output', default=os.path.join(ROOT, 'images', 'pretty-print.gif'))
    ap.add_argument('--indent', type=int, default=2, help='spaces per level (default 2)')
    ap.add_argument('--max-lines', type=int, default=60, help='taller files are cut (default 60)')
    ap.add_argument('--frames', help='also save every frame as PNG in this directory')
    args = ap.parse_args()

    before, after = format_with_extension(args.input, args.indent)
    rows = max(len(before), len(after))
    if rows > args.max_lines:
        print(f'warning: {rows} lines, only the first {args.max_lines} are shown', file=sys.stderr)
        rows = args.max_lines
    longest = max(len(s) for s in before[:rows] + after[:rows])
    filename = os.path.basename(args.input)
    probe = Window(filename, rows, MIN_W, args.indent)
    width = int(probe.gutter + 10 + longest * CW + 30)
    if width > MAX_W:
        print(f'warning: lines up to {longest} chars, cut at {MAX_W}px', file=sys.stderr)
    win = Window(filename, rows, min(max(width, MIN_W), MAX_W), args.indent)

    spans_before, spans_after = highlight(before), highlight(after)
    row_b = min(2, len(before) - 1)
    row_a = min(deepest_text_line(after), rows - 1)
    crumbs_b = ancestry(after, row_a)[:2]
    crumbs_a = ancestry(after, row_a)
    cur_b, cur_a = (row_b, 0), (row_a, indent_of(after[row_a]))

    shot = lambda **kw: win.draw(before, spans_before, cur_b, crumbs_b, **kw)
    frames = [
        (shot(), HOLD_BEFORE),
        (shot(), PAUSE),
        (shot(keys=['Shift']), KEY_STEP),
        (shot(keys=['Shift', 'Alt']), KEY_STEP),
        (shot(keys=['Shift', 'Alt', 'F']), KEYS_HOLD),
        (win.draw(after, spans_after, cur_a, crumbs_a, dirty=True, message='Formatted with Bello SGML'), HOLD_AFTER),
    ]

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    images = [f for f, _ in frames]
    images[0].save(args.output, save_all=True, append_images=images[1:],
                   duration=[ms for _, ms in frames], loop=0, optimize=True)
    if args.frames:
        os.makedirs(args.frames, exist_ok=True)
        for k, im in enumerate(images):
            im.save(os.path.join(args.frames, f'frame-{k}.png'))

    size = os.path.getsize(args.output)
    total = sum(ms for _, ms in frames) / 1000
    print(f'{args.output}: {len(frames)} frames, {total:.1f}s, {win.w}x{win.h}, {size / 1024:.0f} KB')


if __name__ == '__main__':
    main()
