#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Orbit Time document reader.

Turns "a file somebody handed me" into something a model can read: plain text
for documents, and normalised PNG pages for scans and photos. The host then
asks the model to pull the schedule out of it — this script deliberately does
*not* try to understand the schedule itself.

Why a separate process: PDF text extraction (PyMuPDF), DOCX structure
(python-docx) and image normalisation (Pillow) are all one import away in the
bundled Python, and none of them belong in the host's dependency-free half.

Contract
--------
argv[1] : absolute path of the document
argv[2] : JSON options (optional). Recognised keys:
            outDir      - directory for rendered PNGs (created if missing)
            maxChars    - text cap (default 24000)
            maxPages    - pages/slides to walk (default 40)
            maxImages   - page images to render (default 4)
            renderDpi   - rasterisation DPI for scanned pages (default 140)

stdout  : one JSON object. On failure {"ok": false, "error": "..."} and exit 0
          so the caller reports the reason without parsing stderr.

Output
------
{
  "ok": true,
  "kind": "text" | "image" | "pdf" | "docx" | "pptx",
  "file": "<path>",
  "text": "<document text, page markers included>",
  "chars": 1234,
  "truncated": false,
  "pages": [{"page": 1, "chars": 120, "scanned": false}],
  "images": ["C:\\...\\page-2.png"],
  "meta": {"pages": 3, "tables": 2},
  "notes": ["PDF 第 2 页没有文字，已渲染成图片交给模型看。"]
}

A "scanned" page is one whose text layer is empty: its content only exists as
pixels, so it is rendered and handed to the vision-capable model instead of
being reported as an empty page.
"""

import datetime as _dt
import io
import json
import os
import posixpath
import sys
import zipfile

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

MAX_CHARS = 24000
MAX_PAGES = 40
MAX_IMAGES = 4
MAX_EDGE = 1600
RENDER_DPI = 140
MIN_TEXT_BEFORE_RENDER = 40
TEXT_EXTENSIONS = {
    '.txt', '.text', '.md', '.markdown', '.csv', '.tsv', '.json', '.ics',
    '.log', '.yaml', '.yml', '.ini', '.conf', '.xml', '.html', '.htm',
}
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'}


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False))
    raise SystemExit(0)


def fail(message):
    emit({'ok': False, 'error': message})


def clean(text):
    """Collapse the whitespace a document's own layout adds."""
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    lines = [line.rstrip() for line in text.split('\n')]
    out = []
    blank = 0
    for line in lines:
        if line.strip() == '':
            blank += 1
            if blank > 1:
                continue
            out.append('')
        else:
            blank = 0
            out.append(line)
    return '\n'.join(out).strip()


def decode_bytes(raw):
    """Decode a text file with the encodings a Chinese Windows box actually uses."""
    if raw.startswith(b'\xff\xfe') or raw.startswith(b'\xfe\xff'):
        return raw.decode('utf-16', errors='replace'), None
    for encoding in ('utf-8-sig', 'utf-8', 'gb18030'):
        try:
            return raw.decode(encoding), None
        except UnicodeDecodeError:
            continue
    return raw.decode('utf-8', errors='replace'), '文件不是 UTF-8 / GBK，已按替换字符读取，可能有乱码。'


def ensure_out_dir(options):
    out_dir = options.get('outDir')
    if not out_dir:
        out_dir = os.path.join(os.environ.get('TEMP', os.getcwd()), 'orbit-time-read')
    os.makedirs(out_dir, exist_ok=True)
    return out_dir


def normalise_image(raw, target):
    """Re-encode any raster into a bounded PNG the attachment service accepts."""
    from PIL import Image

    with Image.open(io.BytesIO(raw)) as image:
        image = image.convert('RGB')
        image.thumbnail((MAX_EDGE, MAX_EDGE))
        image.save(target, 'PNG')
    return target


def read_image(path, options):
    raw = open(path, 'rb').read()
    if not raw:
        fail('这个文件是空的。')
    out_dir = ensure_out_dir(options)
    target = os.path.join(out_dir, 'image-1.png')
    extension = os.path.splitext(path)[1].lower()
    try:
        normalise_image(raw, target)
    except ImportError:
        if extension in ('.png', '.jpg', '.jpeg', '.webp', '.gif'):
            # Pillow is only a fallback here: the attachment service decodes and
            # normalises these four itself, so the raw bytes are still usable.
            target = path
        else:
            fail('这张图需要 Pillow 才能转成 PNG（当前 Python 没有 Pillow）。')
    except Exception as error:  # noqa: BLE001 - report, never traceback
        fail('这张图打不开，可能已损坏：%s' % error)
    return {
        'ok': True,
        'kind': 'image',
        'file': path,
        'text': '',
        'chars': 0,
        'truncated': False,
        'pages': [],
        'images': [target],
        'meta': {},
        'notes': [],
    }


def read_text(path, options):
    raw = open(path, 'rb').read()
    text, note = decode_bytes(raw)
    text = clean(text)
    limit = int(options.get('maxChars') or MAX_CHARS)
    truncated = len(text) > limit
    if truncated:
        text = text[:limit]
    return {
        'ok': True,
        'kind': 'text',
        'file': path,
        'text': text,
        'chars': len(text),
        'truncated': truncated,
        'pages': [],
        'images': [],
        'meta': {},
        'notes': [note] if note else [],
    }


def read_pdf(path, options):
    try:
        import fitz  # PyMuPDF
    except ImportError:
        fail('读 PDF 需要 PyMuPDF（fitz），当前 Python 没有安装。可以先把 PDF 另存为图片或复制文字。')

    out_dir = ensure_out_dir(options)
    max_pages = int(options.get('maxPages') or MAX_PAGES)
    max_images = int(options.get('maxImages') or MAX_IMAGES)
    dpi = int(options.get('renderDpi') or RENDER_DPI)

    try:
        document = fitz.open(path)
    except Exception as error:  # noqa: BLE001
        fail('这个 PDF 打不开：%s' % error)
    if document.needs_pass:
        fail('这个 PDF 有密码，读不了。')

    chunks = []
    pages = []
    images = []
    notes = []
    total = 0
    for index in range(min(len(document), max_pages)):
        page = document[index]
        try:
            page_text = clean(page.get_text('text') or '')
        except Exception:  # noqa: BLE001 - a broken page must not lose the rest
            page_text = ''
        scanned = len(page_text) < MIN_TEXT_BEFORE_RENDER
        pages.append({'page': index + 1, 'chars': len(page_text), 'scanned': scanned})
        if page_text:
            chunks.append('【第 %d 页】\n%s' % (index + 1, page_text))
            total += len(page_text)
        if scanned and len(images) < max_images:
            try:
                pixmap = page.get_pixmap(dpi=dpi)
                target = os.path.join(out_dir, 'page-%d.png' % (index + 1))
                pixmap.save(target)
                images.append(target)
                chunks.append('【第 %d 页】这一页没有文字层，内容在附带的图片里。' % (index + 1))
                notes.append('第 %d 页没有文字层，已渲染成图片交给模型看。' % (index + 1))
            except Exception as error:  # noqa: BLE001
                notes.append('第 %d 页渲染失败：%s' % (index + 1, error))
    if len(document) > max_pages:
        notes.append('PDF 共 %d 页，只读了前 %d 页。' % (len(document), max_pages))
    document.close()

    text = clean('\n\n'.join(chunks))
    limit = int(options.get('maxChars') or MAX_CHARS)
    truncated = len(text) > limit
    if truncated:
        text = text[:limit]
    return {
        'ok': True,
        'kind': 'pdf',
        'file': path,
        'text': text,
        'chars': len(text),
        'truncated': truncated,
        'pages': pages,
        'images': images,
        'meta': {'pages': len(pages), 'textChars': total},
        'notes': notes,
    }


def _docx_text(document):
    """Paragraphs and tables in the order they appear on the page."""
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    lines = []
    tables = 0
    body = document.element.body
    for child in body.iterchildren():
        tag = child.tag.rsplit('}', 1)[-1]
        if tag == 'p':
            text = Paragraph(child, document).text.strip()
            if text:
                lines.append(text)
        elif tag == 'tbl':
            tables += 1
            table = Table(child, document)
            for row in table.rows:
                cells = []
                for cell in row.cells:
                    value = ' '.join(cell.text.split())
                    # A merged cell repeats its text for every grid column it
                    # covers; keep one copy so the row still reads as columns.
                    if not cells or cells[-1] != value:
                        cells.append(value)
                line = ' | '.join(cells).strip(' |')
                if line.strip(' |'):
                    lines.append(line)
    return '\n'.join(lines), tables


def _docx_embedded_images(document, out_dir, room):
    images = []
    if room <= 0:
        return images
    try:
        for part in document.part.related_parts.values():
            content_type = getattr(part, 'content_type', '')
            if not content_type.startswith('image/'):
                continue
            data = getattr(part, 'blob', None)
            if not data or len(data) < 4000:
                continue
            target = os.path.join(out_dir, 'doc-image-%d.png' % (len(images) + 1))
            try:
                normalise_image(data, target)
            except Exception:  # noqa: BLE001 - an odd embedded image is not fatal
                continue
            images.append(target)
            if len(images) >= room:
                break
    except Exception:  # noqa: BLE001
        pass
    return images


def read_docx(path, options):
    try:
        from docx import Document
    except ImportError:
        fail('读 .docx 需要 python-docx，当前 Python 没有安装。可以把内容复制成文本再读。')

    try:
        document = Document(path)
    except Exception as error:  # noqa: BLE001
        fail('这个 Word 文档打不开：%s' % error)

    text, tables = _docx_text(document)
    text = clean(text)
    notes = []
    images = []
    if tables > 0:
        notes.append('文档里有 %d 张表格，已按「列 | 列 | 列」的文本读出来。' % tables)
    room = int(options.get('maxImages') or MAX_IMAGES)
    if len(text) < 160 and room > 0:
        # A .docx that is only a pasted screenshot has no text to read; hand its
        # images to the model instead of reporting an empty document.
        images = _docx_embedded_images(document, ensure_out_dir(options), room)
        if images:
            notes.append('正文几乎没有文字，已把文档里的 %d 张图片交给模型看。' % len(images))
    return {
        'ok': True,
        'kind': 'docx',
        'file': path,
        'text': text,
        'chars': len(text),
        'truncated': False,
        'pages': [],
        'images': images,
        'meta': {'tables': tables},
        'notes': notes,
    }


def _pptx_text_from_xml(blob):
    """Text of one slide, without python-pptx: every <a:t> in document order."""
    import re

    pieces = []
    for match in re.finditer(r'<a:t>(.*?)</a:t>', blob, re.S):
        value = match.group(1)
        value = value.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
        value = value.replace('&quot;', '"').replace('&apos;', "'")
        if value.strip():
            pieces.append(value.strip())
    return pieces


def read_pptx(path, options):
    try:
        archive = zipfile.ZipFile(path)
    except Exception as error:  # noqa: BLE001
        fail('这个 PPT 打不开：%s' % error)
    slides = []
    with archive:
        names = [name for name in archive.namelist() if name.startswith('ppt/slides/slide') and name.endswith('.xml')]
        names.sort(key=lambda name: int(''.join(ch for ch in posixpath.basename(name) if ch.isdigit()) or 0))
        max_pages = int(options.get('maxPages') or MAX_PAGES)
        for index, name in enumerate(names[:max_pages], 1):
            try:
                pieces = _pptx_text_from_xml(archive.read(name).decode('utf-8', errors='replace'))
            except Exception:  # noqa: BLE001
                continue
            slides.append('【第 %d 页】\n%s' % (index, '\n'.join(pieces)))
    text = clean('\n\n'.join(slides))
    notes = []
    if len(names) > max_pages:
        notes.append('PPT 共 %d 页，只读了前 %d 页。' % (len(names), max_pages))
    notes.append('PPT 只读文字；图表里的数字如果是图片，需要另存成图片再读。')
    return {
        'ok': True,
        'kind': 'pptx',
        'file': path,
        'text': text,
        'chars': len(text),
        'truncated': False,
        'pages': [{'page': index + 1, 'chars': len(chunk), 'scanned': False} for index, chunk in enumerate(slides)],
        'images': [],
        'meta': {'pages': len(slides)},
        'notes': notes,
    }


def main():
    if len(sys.argv) < 2:
        fail('用法：read-document.py <文件> [JSON 选项]')
    path = os.path.abspath(sys.argv[1])
    options = {}
    if len(sys.argv) > 2 and sys.argv[2].strip():
        try:
            options = json.loads(sys.argv[2])
        except ValueError as error:
            fail('选项不是合法 JSON：%s' % error)
    if not os.path.exists(path):
        fail('找不到文件：%s' % path)
    if os.path.isdir(path):
        fail('这是一个文件夹，不是文件：%s' % path)

    extension = os.path.splitext(path)[1].lower()
    if extension in IMAGE_EXTENSIONS:
        emit(read_image(path, options))
    if extension in TEXT_EXTENSIONS:
        emit(read_text(path, options))
    if extension == '.pdf':
        emit(read_pdf(path, options))
    if extension == '.docx':
        emit(read_docx(path, options))
    if extension == '.pptx':
        emit(read_pptx(path, options))
    if extension == '.doc':
        fail('旧版 .doc 读不了，请在 Word 里另存为 .docx 再读。')
    emit({
        'ok': False,
        'error': '这个格式还不支持（%s）。可以读：PDF / Word(.docx) / PPT(.pptx) / 纯文本 / 图片。' % (extension or '无扩展名'),
    })


if __name__ == '__main__':
    main()
