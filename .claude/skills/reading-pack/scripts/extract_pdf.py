#!/usr/bin/env python3
"""
从 PDF 读物中提取每页图和每页音频，产出 probe 目录供组装 .rdpkg。

绘本每页本来就印着文字，所以直接用整页原图，不抠图、不识别文字。

支持：
  · RichMedia 型（RAZ / Reading A-Z 等）—— 每页一个 /Subtype /Sound 注释，内含 mp3
  · 无音频型 —— 只出页面图，朗读交给 App 的 TTS（此时 plan 里需补 text）

产出（默认在 <out>/ 下）：
  pages/pNN.jpg     整页图，直接给孩子看
  audio/<原始名>     每页音频，保留 PDF 内的原始命名
  probe.json        页码 → 图/音频/时长 的映射

用法：
  uv run --with pymupdf python extract_pdf.py <input.pdf> <out_dir> [--width 900]
"""

import json
import re
import subprocess
import sys
from pathlib import Path

import fitz  # pymupdf

DEFAULT_WIDTH = 900  # 页面图宽度（px），平板上够清晰又不让包变胖
AUDIO_EXTS = (".mp3", ".m4a", ".wav", ".mp4")


def utf16_hex_to_str(s: str) -> str:
    """PDF 里 <FEFF0041...> 形式的 UTF-16BE 十六进制字符串转普通字符串。"""
    try:
        b = bytes.fromhex(s.strip().lstrip("<").rstrip(">"))
    except ValueError:
        return ""
    if b[:2] == b"\xfe\xff":
        b = b[2:]
    return b.decode("utf-16-be", errors="replace")


# 两种常见的内嵌音频做法，都从注释出发：
#   RichMedia：annot → /RichMediaContent → /Assets → /Names → Filespec → /EF
#   Screen   ：annot → /A(Rendition) → /R → /C(MediaClip) → /D → Filespec → /EF
MEDIA_ANNOT_TYPES = (fitz.PDF_ANNOT_RICH_MEDIA, fitz.PDF_ANNOT_SCREEN)

# 绝不跟随这两个键：它们指回所属页/父节点，一路能走到整个页面树，
# 于是这一页会摸到别页的音频，映射就错位了。
UPWARD_KEYS = re.compile(r"/(?:P|Parent)\s+\d+\s+0\s+R")


def resolve_page_audio(doc):
    """返回 {页码(1-based): (文件名, 流对象xref)}。逐页从注释向下走，不向上逃逸。"""
    result = {}
    for pno, page in enumerate(doc, start=1):
        for annot in page.annots() or []:
            if annot.type[0] not in MEDIA_ANNOT_TYPES:
                continue
            seen, queue, depth = set(), [(annot.xref, 0)], 0
            while queue:
                xref, depth = queue.pop(0)
                if xref in seen or depth > 12:
                    continue
                seen.add(xref)
                try:
                    src = doc.xref_object(xref)
                except Exception:
                    continue

                # Filespec：/EF << /F N 0 R >> 加上 /F (name) 或 /UF <hex>
                ef = re.search(r"/EF\s*<<\s*/F\s+(\d+)\s+0\s+R", src)
                if ef:
                    m = re.search(r"/F\s*\(([^)]+)\)", src)
                    if m:
                        name = m.group(1)
                    else:
                        m = re.search(r"/U?F\s*(<[0-9A-Fa-f]+>)", src)
                        name = utf16_hex_to_str(m.group(1)) if m else ""
                    # 每页取第一个音频；同组里另一个可能是 AudioPlayer.swf 播放器外壳
                    if name.lower().endswith(AUDIO_EXTS) and pno not in result:
                        result[pno] = (name, int(ef.group(1)))

                pruned = UPWARD_KEYS.sub("", src)
                queue.extend((int(r.group(1)), depth + 1)
                             for r in re.finditer(r"(\d+)\s+0\s+R", pruned))
    return result


def check_mapping(pages):
    """交叉校验：文件名里带页码提示时（RAZ 命名如 _p3_text.mp3），核对是否对得上本页。

    命名规律因出版方而异，所以只警告、不阻断。
    """
    problems = []
    for p in pages:
        if not p["audio"]:
            continue
        m = re.search(r"_p(\d+)_", p["audio"])
        if m and int(m.group(1)) != p["page"]:
            problems.append(f"第 {p['page']} 页拿到的是 {Path(p['audio']).name}")
    return problems


def media_duration(path: Path):
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, timeout=20,
        )
        return round(float(out.stdout.strip()), 2)
    except Exception:
        return None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        print(__doc__)
        sys.exit(1)
    width = DEFAULT_WIDTH
    for a in sys.argv[1:]:
        if a.startswith("--width"):
            width = int(a.split("=", 1)[1]) if "=" in a else width

    pdf_path, out_dir = Path(args[0]), Path(args[1])
    (out_dir / "pages").mkdir(parents=True, exist_ok=True)

    doc = fitz.open(pdf_path)
    page_audio = resolve_page_audio(doc)

    pages = []
    for pno, page in enumerate(doc, start=1):
        img_rel = f"pages/p{pno:02d}.jpg"
        scale = width / page.rect.width
        page.get_pixmap(matrix=fitz.Matrix(scale, scale)).save(
            out_dir / img_rel, jpg_quality=78
        )

        audio_rel, dur = None, None
        if pno in page_audio:
            name, stream_xref = page_audio[pno]
            try:
                data = doc.xref_stream(stream_xref)
            except Exception:
                data = None
            if data:
                (out_dir / "audio").mkdir(parents=True, exist_ok=True)
                dest = out_dir / "audio" / re.sub(r"[^\w.\-]", "_", name)
                if not dest.exists():
                    dest.write_bytes(data)
                audio_rel = f"audio/{dest.name}"
                dur = media_duration(dest)

        pages.append({
            "page": pno,
            "image": img_rel,
            "audio": audio_rel,
            "audio_seconds": dur,
        })

    probe = {
        "source_pdf": pdf_path.name,
        "page_count": doc.page_count,
        "pages": pages,
    }
    (out_dir / "probe.json").write_text(
        json.dumps(probe, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    with_audio = [p["page"] for p in pages if p["audio"]]
    print(f"✓ {doc.page_count} 页，{len(with_audio)} 页有音频：{with_audio}")
    for msg in check_mapping(pages):
        print(f"  ⚠ 页码与音频文件名不一致：{msg}")
    print(f"  → {out_dir}/probe.json")


if __name__ == "__main__":
    main()
