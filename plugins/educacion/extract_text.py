"""Extrae texto de materiales escolares: PDF, imágenes, Office y texto plano.

OCR local opcional mediante Tesseract. Nunca envía archivos fuera del HTPC.
"""
import os
import pathlib
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

path = pathlib.Path(sys.argv[1])
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 60000
ext = path.suffix.lower()
image_exts = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}


def tesseract_path():
    candidates = [
        os.environ.get("EDUCACION_TESSERACT_PATH", ""),
        shutil.which("tesseract"),
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    ]
    for binary in candidates:
        if binary and pathlib.Path(binary).is_file():
            return str(binary)
    return None


def tesseract_language(binary):
    try:
        cp = subprocess.run([binary, "--list-langs", *tessdata_args], capture_output=True, text=True, timeout=5)
        installed = set(cp.stdout.splitlines()[1:])
        if "spa" in installed and "eng" in installed:
            return "spa+eng"
        return "spa" if "spa" in installed else "eng"
    except Exception:
        return "eng"


data_dir = os.environ.get("SOL_PLUGIN_DATA_DIR", "").strip()
configured_tessdata = os.environ.get("EDUCACION_TESSDATA_DIR", "").strip()
if configured_tessdata:
    tessdata_directory = pathlib.Path(configured_tessdata)
elif data_dir:
    tessdata_directory = pathlib.Path(data_dir) / "educacion" / "tessdata"
else:
    tessdata_directory = None
tessdata_args = ["--tessdata-dir", str(tessdata_directory)] if (
    tessdata_directory and (tessdata_directory / "spa.traineddata").is_file()
) else []
binary = tesseract_path()
language = tesseract_language(binary) if binary else "eng"


def ocr(payload):
    if not binary:
        return ""
    try:
        cp = subprocess.run([binary, "stdin", "stdout", "-l", language, "--psm", "3", *tessdata_args],
                            input=payload, capture_output=True, timeout=30)
        return cp.stdout.decode("utf-8", errors="replace") if cp.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


try:
    if ext == ".pdf":
        import fitz
        chunks = []
        with fitz.open(path) as doc:
            for page in doc:
                if sum(len(x) for x in chunks) >= limit:
                    break
                extracted = page.get_text()
                if len(extracted.strip()) < 60 and binary:
                    image = page.get_pixmap(matrix=fitz.Matrix(1.7, 1.7), alpha=False)
                    ocr_text = ocr(image.tobytes("png"))
                    if len(ocr_text.strip()) > len(extracted.strip()):
                        extracted = ocr_text
                chunks.append(extracted)
        text = "\n".join(chunks)
    elif ext in image_exts:
        text = ocr(path.read_bytes())
    elif ext in (".docx", ".pptx", ".xlsx"):
        with zipfile.ZipFile(path) as archive:
            if ext == ".docx":
                names = ["word/document.xml"]
            elif ext == ".pptx":
                names = sorted(n for n in archive.namelist()
                               if n.startswith("ppt/slides/slide") and n.endswith(".xml"))
            else:
                names = ["xl/sharedStrings.xml"]
            out = []
            for name in names:
                if name not in archive.namelist():
                    continue
                root = ET.fromstring(archive.read(name))
                out.append(" ".join((node.text or "") for node in root.iter() if node.tag.endswith("}t")))
            text = "\n".join(out)
    elif ext in (".txt", ".csv", ".md", ".html", ".htm"):
        text = path.read_text(encoding="utf-8", errors="replace")
    else:
        text = ""
    print(text[:limit])
except Exception as error:
    print(f"EXTRACTION_ERROR: {type(error).__name__}: {error}", file=sys.stderr)
    sys.exit(1)
