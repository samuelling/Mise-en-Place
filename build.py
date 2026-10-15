#!/usr/bin/env python3
"""Wrap page.html (artifact-format body) into a full index.html for GitHub Pages."""
from pathlib import Path
root = Path(__file__).parent
body = (root / 'page.html').read_text()
(root / 'index.html').write_text(
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    '</head>\n<body>\n' + body + '\n</body>\n</html>\n')
print('wrote index.html')
