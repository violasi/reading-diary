#!/usr/bin/env python3
"""
从 PDF 读物中提取每页图和每页音频，产出 probe 目录供组装 .rdpkg。

绘本每页本来就印着文字，所以直接用整页原图，不抠图、不识别文字。

支持：
  · RichMedia 型（RAZ / Reading A-Z 等）—— 每页一个 /Subtype /Sound 注释，内含 mp3
  · 无音频型 —— 只出页面图，朗读交给 App 的 TTS（此时 plan 里需补 text）

  · --split=spread —— 扫描版跨页专用（牛津树自然拼读那批）。这类 PDF 一页 = 一个
    物理跨页 = **两个书页**并排（1485x1050 横版），四周还有大片白边。竖屏平板上
    整张塞进去，每个书页只占半个屏宽，字小到读不了。
    这个模式把每页按正中切成左右两半、各自裁掉白边、当成两页输出，
    并自动丢掉空白的那半（末页常是「左空白 + 右一页」）。
    页号规则：PDF 第 N 页 → 左半 2N-1、右半 2N（**不重排**，
    这样 probe.json 的页号永远能反推回原 PDF 的哪一页哪半边）。

  · --layout=picturebook —— 亲子阅读绘本专用。有些绘本 PDF 是「一张高清跨页扫图
    ＋ 一段转录文字」拼在 A4 版面上，四周大片空白、还印着大号页码。整页缩放渲染
    会把高清插图压小、文字也跟着糊；更糟的是这类 PDF 常用子集化的 CJK 内嵌字体
    （如 MPDFAA+HiraginoSansGBW3，Type0/Identity-H），MuPDF 解不开字形映射，
    整段文字会渲染成空白或错字 —— 看起来就像「原文的大字被删掉了」。
    这个模式改成：取内嵌插图的原始像素 + 用 PyMuPDF 自带的 CJK 字体把
    get_text() 读出的文字重新排在图下面，字号按输出宽度放大到孩子看得清。

产出（默认在 <out>/ 下）：
  pages/pNN.jpg     整页图，直接给孩子看
  audio/<原始名>     每页音频，保留 PDF 内的原始命名
  probe.json        页码 → 图/音频/时长 的映射

用法：
  uv run --with pymupdf python extract_pdf.py <input.pdf> <out_dir> [--width 900]
  uv run --with pymupdf python extract_pdf.py <绘本.pdf> <out_dir> --layout=picturebook --width=1400
  uv run --with pymupdf python extract_pdf.py <跨页扫描.pdf> <out_dir> --split=spread --width=800
"""

import json
import re
import subprocess
import sys
from pathlib import Path

import fitz  # pymupdf

DEFAULT_WIDTH = 900  # 页面图宽度（px），平板上够清晰又不让包变胖
AUDIO_EXTS = (".mp3", ".m4a", ".wav", ".mp4")

# picturebook 模式的排版常数
PB_PAD = 40           # 四边留白（按输出宽度 1400 校的）
PB_FONT_DIVISOR = 26  # 字号 = 输出宽度 / 这个数：1400 → 54px，孩子一臂距离看得清
PB_LINE_HEIGHT = 1.5

# --split=spread 的常数
INK_SCALE = 0.14      # 找墨迹范围用的探测分辨率，够定位白边、又快
INK_MAX = 246         # 亮过这个值算白纸（扫描件的白其实是 248~252，不是纯 255）
INK_MIN_RATIO = 0.004 # 墨迹少于半边面积的 0.4% 就当空白页丢掉
TRIM_PAD_PT = 6       # 裁白边时四周留一点，别把字母贴到边上


def ink_bbox(page, clip, max_ink=INK_MAX):
    """
    在 clip 区域内找「有墨迹」的最小矩形，返回 PDF 坐标的 Rect；全白返回 None。

    先用很低的分辨率渲一张探测图逐像素扫，再把像素坐标换回 PDF 坐标 ——
    直接按目标分辨率渲一张来扫的话，一本书要扫掉上亿个像素。
    """
    pix = page.get_pixmap(matrix=fitz.Matrix(INK_SCALE, INK_SCALE), clip=clip, colorspace=fitz.csGRAY)
    w, h, data = pix.width, pix.height, pix.samples
    if not w or not h:
        return None
    x0, y0, x1, y1, ink = w, h, -1, -1, 0
    for y in range(h):
        row = data[y * pix.stride : y * pix.stride + w]
        for x in range(w):
            if row[x] <= max_ink:
                ink += 1
                if x < x0: x0 = x
                if x > x1: x1 = x
                if y < y0: y0 = y
                if y > y1: y1 = y
    if x1 < 0 or ink < w * h * INK_MIN_RATIO:
        return None
    # 像素 → PDF 坐标。+1 是因为 x1/y1 是「最后一个有墨的像素」，要包含它整格
    sx, sy = clip.width / w, clip.height / h
    r = fitz.Rect(
        clip.x0 + x0 * sx - TRIM_PAD_PT,
        clip.y0 + y0 * sy - TRIM_PAD_PT,
        clip.x0 + (x1 + 1) * sx + TRIM_PAD_PT,
        clip.y0 + (y1 + 1) * sy + TRIM_PAD_PT,
    )
    return r & clip  # 留白别越出这半边，否则会把邻页的字带进来


def spread_halves(page, width: int):
    """
    把一个跨页切成左右两半，各自裁掉白边。

    返回 [(半边序号 0/1, 裁好的 Rect, 渲染矩阵)]，空白的那半不返回。
    """
    r = page.rect
    mid = (r.x0 + r.x1) / 2
    out = []
    for i, clip in enumerate((fitz.Rect(r.x0, r.y0, mid, r.y1),
                              fitz.Rect(mid, r.y0, r.x1, r.y1))):
        trimmed = ink_bbox(page, clip)
        if trimmed is None or trimmed.is_empty:
            continue
        scale = width / trimmed.width
        out.append((i, trimmed, fitz.Matrix(scale, scale)))
    return out


def render_picturebook_page(doc, page, out_path: Path, width: int) -> None:
    """
    绘本页：内嵌插图原始像素 + 重新排版的文字。见模块头 --layout=picturebook 说明。

    找不到内嵌图就退回整页渲染 —— 至少不会产出空白页。
    """
    images = page.get_images()
    if not images:
        scale = width / page.rect.width
        page.get_pixmap(matrix=fitz.Matrix(scale, scale)).save(out_path, jpg_quality=82)
        return

    # 取面积最大的那张，就是跨页插图；页码之类的小图不要
    xref = max(images, key=lambda im: im[2] * im[3])[0]
    pix = fitz.Pixmap(doc, xref)
    if pix.alpha:  # 带透明通道的话 JPEG 存不了
        pix = fitz.Pixmap(fitz.csRGB, pix)

    text = page.get_text().strip()
    img_h = round(width * pix.height / pix.width)
    font_size = round(width / PB_FONT_DIVISOR)

    text_h = 0
    if text:
        # 先在一张很高的临时页上量文字真正占多高，避免猜高度猜不准
        scratch = fitz.open()
        sp = scratch.new_page(width=width, height=8000)
        left = sp.insert_textbox(
            fitz.Rect(PB_PAD, 0, width - PB_PAD, 8000),
            text,
            fontsize=font_size,
            fontname="china-s",  # PyMuPDF 自带简体中文，不依赖系统字体
            lineheight=PB_LINE_HEIGHT,
        )
        text_h = round(8000 - left) + PB_PAD
        scratch.close()

    out = fitz.open()
    canvas = out.new_page(width=width, height=img_h + text_h + PB_PAD)
    canvas.draw_rect(canvas.rect, color=None, fill=(1, 1, 1))
    canvas.insert_image(fitz.Rect(0, 0, width, img_h), pixmap=pix)
    if text:
        canvas.insert_textbox(
            fitz.Rect(PB_PAD, img_h + PB_PAD * 0.6, width - PB_PAD, img_h + text_h + PB_PAD),
            text,
            fontsize=font_size,
            fontname="china-s",
            lineheight=PB_LINE_HEIGHT,
            color=(0.12, 0.11, 0.1),
        )
    # dpi=96 时 1pt=1px，页面尺寸就是像素尺寸
    canvas.get_pixmap(dpi=96).save(out_path, jpg_quality=82)
    out.close()


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
    layout = "page"
    split = "none"
    for a in sys.argv[1:]:
        if a.startswith("--width"):
            width = int(a.split("=", 1)[1]) if "=" in a else width
        elif a.startswith("--layout"):
            layout = a.split("=", 1)[1] if "=" in a else layout
        elif a.startswith("--split"):
            split = a.split("=", 1)[1] if "=" in a else "spread"

    pdf_path, out_dir = Path(args[0]), Path(args[1])
    (out_dir / "pages").mkdir(parents=True, exist_ok=True)

    doc = fitz.open(pdf_path)
    page_audio = resolve_page_audio(doc)

    # 跨页切半：一页出两页，页号 2N-1 / 2N。这类扫描件没有内嵌音频
    # （音频是单独一条整本 mp3，由 plan 的 book_audio 带进去），所以不查 page_audio。
    if split == "spread":
        pages, blanks = [], []
        for pno, page in enumerate(doc, start=1):
            halves = spread_halves(page, width)
            for i in (0, 1):
                out_pno = pno * 2 - 1 + i
                hit = next((h for h in halves if h[0] == i), None)
                if hit is None:
                    blanks.append(out_pno)
                    continue
                _, clip, mat = hit
                img_rel = f"pages/p{out_pno:02d}.jpg"
                page.get_pixmap(matrix=mat, clip=clip).save(
                    out_dir / img_rel, jpg_quality=80
                )
                pages.append({
                    "page": out_pno,
                    "image": img_rel,
                    "audio": None,
                    "audio_seconds": None,
                    "from": f"PDF 第 {pno} 页{'左' if i == 0 else '右'}半",
                })
        probe = {
            "source_pdf": pdf_path.name,
            "page_count": len(pages),
            "split": "spread",
            "pdf_page_count": doc.page_count,
            "pages": pages,
        }
        (out_dir / "probe.json").write_text(
            json.dumps(probe, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"✓ {doc.page_count} 个跨页 → {len(pages)} 个单页"
              f"（页号 {pages[0]['page']}…{pages[-1]['page']}）")
        if blanks:
            print(f"  · 空白半页已丢弃：{blanks}")
        print(f"  ⚠ 这批书没有逐页音频，plan 里要用 book_audio 挂整本音轨")
        print(f"  → {out_dir}/probe.json")
        return

    pages = []
    for pno, page in enumerate(doc, start=1):
        img_rel = f"pages/p{pno:02d}.jpg"
        if layout == "picturebook":
            render_picturebook_page(doc, page, out_dir / img_rel, width)
        else:
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
