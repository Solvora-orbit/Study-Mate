#!/usr/bin/env python3
"""Read the course materials sitting in the workspace and turn them into citable notes.

A course video usually ships with slides, handouts or a textbook excerpt. Those fill the
gap left by not reading the video picture: formulas, board work and slide text come from
the PDF instead of from frame OCR.

    python materials.py                          # auto-discover materials in the workspace
    python materials.py 课件/ 讲义.pdf -o skills/qm/references/课件笔记
    python materials.py 扫描件.pdf --cloud-ocr    # scanned PDF -> MinerU cloud (uploads it)

Text PDFs, PPTX, DOCX, MD and TXT are parsed locally and never leave the machine.
Scanned PDFs cannot be read locally; --cloud-ocr sends them to mineru.net (needs
MINERU_API_TOKEN) and must be asked for explicitly, because it uploads the file.
"""

import argparse
import json
import os
import re
import sys
import time
import zipfile
from pathlib import Path

MATERIAL_EXTS = {".pdf", ".pptx", ".docx", ".md", ".txt", ".markdown"}
# Directories people actually dump course files into; checked before scanning the root.
CONVENTION_DIRS = ("课件", "courseware", "materials", "讲义", "slides", "ppt", "资料")

# A PDF page with less than this many characters is treated as an image, which is how
# scanned handouts announce themselves. 40 is comfortably below a real slide's text.
MIN_CHARS_PER_PAGE = 40
MINERU_BASE = os.getenv("MINERU_API_BASE", "https://mineru.net/api/v4")
MINERU_TOKEN = os.getenv("MINERU_API_TOKEN", "")


# --------------------------------------------------------------------------- parsing

def text_from_pptx(path: Path) -> list[tuple[str, str]]:
    """Return [(slide_label, text)]. Slide numbers come from the file names pptx uses."""
    out = []
    with zipfile.ZipFile(path) as zf:
        slides = sorted(
            (n for n in zf.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
            key=lambda n: int(re.search(r"(\d+)", Path(n).stem).group(1)),
        )
        for name in slides:
            xml = zf.read(name).decode("utf-8", errors="ignore")
            # ponytail: stdlib unzip + <a:t> instead of python-pptx -- we only need the
            # text, and this keeps the dependency list at pypdf alone. Swap in python-pptx
            # if you ever need speaker notes, tables or layouts.
            parts = re.findall(r"<a:t>(.*?)</a:t>", xml, re.S)
            text = " ".join(p.strip() for p in parts if p.strip())
            if text:
                n = int(re.search(r"(\d+)", Path(name).stem).group(1))
                out.append((f"第{n}张", text))
    return out


def text_from_docx(path: Path) -> list[tuple[str, str]]:
    """Return [(paragraph_label, text)] grouped per chunk of the document body."""
    with zipfile.ZipFile(path) as zf:
        xml = zf.read("word/document.xml").decode("utf-8", errors="ignore")
    paragraphs = re.findall(r"<w:p[ >].*?</w:p>", xml, re.S)
    lines = []
    for para in paragraphs:
        runs = re.findall(r"<w:t[^>]*>(.*?)</w:t>", para, re.S)
        text = "".join(runs).strip()
        if text:
            lines.append(text)
    # A docx has no pages; group by 40 paragraphs so citations stay nearby.
    return [(f"第{i // 40 + 1}段", t) for i, t in enumerate(lines)]


def text_from_pdf(path: Path) -> tuple[list[tuple[str, str]], int, int]:
    """Return ([(第N页, text)], page_count, scanned_page_count)."""
    try:
        from pypdf import PdfReader
    except ImportError:
        raise SystemExit(
            "[error] reading PDFs needs pypdf:  pip install pypdf\n"
            "        (MD/TXT/PPTX/DOCX need nothing extra)"
        )
    reader = PdfReader(str(path))
    pages, scanned = [], 0
    for i, page in enumerate(reader.pages, 1):
        try:
            text = (page.extract_text() or "").strip()
        except Exception:
            text = ""
        if len(text) < MIN_CHARS_PER_PAGE:
            scanned += 1
            continue
        pages.append((f"第{i}页", " ".join(text.split())))
    return pages, len(reader.pages), scanned


def read_material(path: Path) -> list[tuple[str, str]]:
    suffix = path.suffix.lower()
    if suffix in (".md", ".txt", ".markdown"):
        return [("全文", " ".join(path.read_text(encoding="utf-8", errors="ignore").split()))]
    if suffix == ".pdf":
        pages, _, _ = text_from_pdf(path)
        return pages
    if suffix == ".pptx":
        return text_from_pptx(path)
    if suffix == ".docx":
        return text_from_docx(path)
    raise ValueError(f"unsupported: {path.name}")


# --------------------------------------------------------------------------- discovery

def discover(explicit: list[str]) -> list[Path]:
    found: dict[Path, None] = {}
    if explicit:
        for raw in explicit:
            p = Path(raw).expanduser()
            if p.is_dir():
                for item in sorted(p.rglob("*")):
                    if item.suffix.lower() in MATERIAL_EXTS and item.is_file():
                        found[item] = None
            elif p.is_file():
                found[p] = None
            else:
                print(f"[warn] no such file or directory: {raw}", file=sys.stderr)
        return list(found)
    for name in CONVENTION_DIRS:
        d = Path(name)
        if d.is_dir():
            for item in sorted(d.rglob("*")):
                if item.suffix.lower() in MATERIAL_EXTS and item.is_file():
                    found[item] = None
    for item in sorted(Path(".").iterdir()):
        if item.is_file() and item.suffix.lower() in MATERIAL_EXTS:
            found[item] = None
    return list(found)


def lesson_number(path: Path) -> int | None:
    m = re.search(r"(\d{1,3})", path.stem)
    return int(m.group(1)) if m else None


# --------------------------------------------------------------------------- cloud OCR

def mineru_parse(paths: list[Path], workdir: Path, model_version: str, language: str) -> dict[str, list[tuple[str, str]]]:
    """Send scanned PDFs to mineru.net and bring back Markdown. Only called with --cloud-ocr."""
    import requests

    if not MINERU_TOKEN:
        raise SystemExit(
            "[error] --cloud-ocr needs a MinerU token (free): https://mineru.net\n"
            "        export MINERU_API_TOKEN=..."
        )
    headers = {"Authorization": f"Bearer {MINERU_TOKEN}", "Content-Type": "application/json"}

    def safe_id(p: Path) -> str:
        return (re.sub(r"[^0-9A-Za-z\u4e00-\u9fff._-]+", "_", p.stem).strip("_") or "doc")[:100]

    payload = {
        "enable_formula": True,
        "enable_table": True,
        "language": language,
        "model_version": model_version,
        "files": [{"name": f"{safe_id(p)}.pdf", "is_ocr": True, "data_id": safe_id(p)} for p in paths],
    }
    resp = requests.post(f"{MINERU_BASE.rstrip('/')}/file-urls/batch", headers=headers,
                         data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), timeout=60)
    resp.raise_for_status()
    body = resp.json()
    if body.get("code") != 0:
        raise SystemExit(f"[error] MinerU refused the upload request: {body}")
    data = body["data"]
    urls = data.get("file_urls") or []
    if len(urls) != len(paths):
        raise SystemExit(f"[error] MinerU returned {len(urls)} upload URLs for {len(paths)} files")
    for src, item in zip(paths, urls):
        print(f"  uploading {src.name} (this leaves your machine)")
        with src.open("rb") as fh:
            up = requests.put(item["upload_url"], data=fh, timeout=600)
        up.raise_for_status()

    print("  waiting for MinerU to parse (scanned files take a while)")
    while True:
        r = requests.get(f"{MINERU_BASE.rstrip('/')}/extract-results/batch/{data['batch_id']}",
                         headers=headers, timeout=60)
        r.raise_for_status()
        results = r.json().get("data", {}).get("extract_result", [])
        if results and all(i.get("state") == "done" for i in results):
            break
        failed = [i for i in results if i.get("state") == "failed"]
        if failed:
            raise SystemExit(f"[error] MinerU failed on: {[i.get('data_id') for i in failed]}")
        time.sleep(20)

    out: dict[str, list[tuple[str, str]]] = {}
    for item in results:
        data_id = item["data_id"]
        target = workdir / "mineru" / data_id
        target.mkdir(parents=True, exist_ok=True)
        zip_path = target / "full.zip"
        if not zip_path.exists():
            blob = requests.get(item["full_zip_url"], timeout=600)
            blob.raise_for_status()
            zip_path.write_bytes(blob.content)
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(target)
        chunks: list[tuple[str, str]] = []
        for md in sorted(target.rglob("*.md")):
            text = " ".join(md.read_text(encoding="utf-8", errors="ignore").split())
            if text:
                chunks.append((f"{md.parent.name}/{md.stem}", text))
        out[data_id] = chunks
    return out


# --------------------------------------------------------------------------- main

def main() -> int:
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="*", help="material files/dirs (default: auto-discover)")
    ap.add_argument("-o", "--outdir", default="课件笔记", help="where the .md notes go (default: 课件笔记)")
    ap.add_argument("--cloud-ocr", action="store_true",
                    help="send scanned PDFs to mineru.net for OCR (uploads the files; needs MINERU_API_TOKEN)")
    ap.add_argument("--model-version", default=os.getenv("MINERU_MODEL_VERSION", "vlm"))
    ap.add_argument("--language", default=os.getenv("MINERU_LANGUAGE", "ch"))
    args = ap.parse_args()

    files = discover(args.paths)
    if not files:
        print("[info] no course materials found. Pass paths explicitly, or drop them in one of:\n"
              f"       {', '.join(CONVENTION_DIRS[:4])}/")
        return 0

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    manifest: dict = {"sources": [], "scanned": [], "no_text": [], "errors": []}
    scanned_pdfs: list[Path] = []

    for path in files:
        print(f"[read] {path.name}")
        try:
            if path.suffix.lower() == ".pdf":
                _, pages_total, scanned_pages = text_from_pdf(path)
                if scanned_pages and scanned_pages >= max(1, pages_total // 2):
                    manifest["scanned"].append({"file": str(path), "pages": pages_total,
                                                "scanned_pages": scanned_pages})
                    scanned_pdfs.append(path)
                    print(f"  [warn] looks scanned ({scanned_pages}/{pages_total} pages are images)")
                    continue
            chunks = read_material(path)
        except SystemExit as e:
            print(str(e), file=sys.stderr)
            manifest["errors"].append({"file": str(path), "error": "parser unavailable"})
            continue
        except Exception as e:
            print(f"  [warn] could not read: {e}", file=sys.stderr)
            manifest["errors"].append({"file": str(path), "error": str(e)})
            continue
        if not chunks:
            manifest["no_text"].append(str(path))
            print("  [warn] no extractable text")
            continue
        body = [f"# {path.stem}", "", f"> 来源：`{path}`", ""]
        for label, text in chunks:
            body += [f"## {label}", "", text, ""]
        target = outdir / f"{path.stem}.md"
        target.write_text("\n".join(body).rstrip() + "\n", encoding="utf-8")
        manifest["sources"].append({
            "file": str(path), "note": str(target), "chunks": len(chunks),
            "lesson": lesson_number(path), "chars": sum(len(t) for _, t in chunks),
        })
        print(f"  -> {target.name} ({len(chunks)} section(s))")

    if args.cloud_ocr and scanned_pdfs:
        print(f"\n[cloud] sending {len(scanned_pdfs)} scanned PDF(s) to MinerU")
        by_id = mineru_parse(scanned_pdfs, outdir, args.model_version, args.language)
        for path, chunks in zip(scanned_pdfs, by_id.values()):
            body = [f"# {path.stem}（扫描件 OCR）", "", f"> 来源：`{path}`，由 MinerU 云端解析", ""]
            for label, text in chunks:
                body += [f"## {label}", "", text, ""]
            target = outdir / f"{path.stem}.md"
            target.write_text("\n".join(body).rstrip() + "\n", encoding="utf-8")
            manifest["sources"].append({
                "file": str(path), "note": str(target), "chunks": len(chunks),
                "lesson": lesson_number(path), "chars": sum(len(t) for _, t in chunks),
                "source": "mineru-cloud",
            })
            print(f"  -> {target.name} (OCR)")
    elif scanned_pdfs:
        print("\n[hint] scanned PDF(s) were skipped. Re-run with --cloud-ocr to OCR them")
        print("       (that uploads the file to mineru.net; needs a free MINERU_API_TOKEN).")

    (outdir / "_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    total = sum(s["chars"] for s in manifest["sources"])
    print(f"\n[done] {len(manifest['sources'])} material(s), {total} chars -> {outdir}/_manifest.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
