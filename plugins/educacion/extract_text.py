"""Optional local text extraction. Never uploads school material."""
import sys, pathlib, zipfile, xml.etree.ElementTree as ET
path = pathlib.Path(sys.argv[1])
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 60000
ext = path.suffix.lower()
try:
    if ext == '.pdf':
        import fitz
        with fitz.open(path) as doc:
            text = '\n'.join(page.get_text() for page in doc)
    elif ext in ('.docx','.pptx','.xlsx'):
        with zipfile.ZipFile(path) as archive:
            if ext == '.docx':
                names = ['word/document.xml']
            elif ext == '.pptx':
                names = sorted(n for n in archive.namelist() if n.startswith('ppt/slides/slide') and n.endswith('.xml'))
            else:
                names = ['xl/sharedStrings.xml']
            out = []
            for name in names:
                if name not in archive.namelist(): continue
                root = ET.fromstring(archive.read(name))
                out.append(' '.join((node.text or '') for node in root.iter() if node.tag.endswith('}t')))
            text = '\n'.join(out)
    elif ext in ('.txt','.csv','.md','.html','.htm'):
        text = path.read_text(encoding='utf-8', errors='replace')
    else:
        text = ''
    print(text[:limit])
except Exception as error:
    print(f'EXTRACTION_ERROR: {type(error).__name__}: {error}', file=sys.stderr)
    sys.exit(1)
