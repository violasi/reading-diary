#!/usr/bin/env python3
"""
按 plan.json 组装 .rdpkg 任务包。

只做机械活：按 plan 指定的页码取图和音频、写 manifest、打 zip。
无第三方依赖（页面图在 extract_pdf.py 里已经压好，这里不再动）。

用法：
  python3 build_pack.py <plan.json> <out_dir>
"""

import json
import shutil
import sys
import zipfile
from pathlib import Path


def build_piece(piece: dict, stage: Path, warnings: list):
    src_dir = Path(piece["source_dir"])
    probe = json.loads((src_dir / "probe.json").read_text(encoding="utf-8"))
    by_page = {p["page"]: p for p in probe["pages"]}
    pid = piece["id"]

    def take_image(pno: int, rel: str):
        info = by_page[pno]
        dest = stage / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_dir / info["image"], dest)
        return rel

    out_pages = []
    for i, pno in enumerate(piece["pages"]):
        if pno not in by_page:
            raise SystemExit(f"[{pid}] plan 里写了第 {pno} 页，但 probe.json 没有这一页")
        info = by_page[pno]

        audio_rel = None
        if info.get("audio"):
            ext = Path(info["audio"]).suffix
            audio_rel = f"audio/{pid}-s{i}{ext}"
            (stage / "audio").mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_dir / info["audio"], stage / audio_rel)

        entry = {"image": take_image(pno, f"images/{pid}-s{i}.jpg"), "audio": audio_rel}
        # text 只在没有音频、需要 TTS 时才用得上；plan 里给了就带上
        text = (piece.get("texts") or {}).get(str(pno))
        if text:
            entry["text"] = text
        out_pages.append(entry)

    # 音频有两种形态，孩子端给的按钮不一样（见 App 的 src/types.ts）：
    #   逐页音频（RAZ 那类，PDF 里每页一个 Sound 注释）→ 「听这页」「连着听」
    #   整本音轨（plan 里写 book_audio）              → 「整本听」，翻页不打断
    #   一点都没有                                     → 纯图，自由翻页
    # 整本都没逐页音频是正常形态，不该报警；有的页有、有的页没有才是漏了。
    n_audio = sum(1 for e in out_pages if e["audio"])
    n_text = sum(1 for e in out_pages if e.get("text"))
    if n_audio and n_audio < len(out_pages):
        missing = [pno for pno, e in zip(piece["pages"], out_pages) if not e["audio"]]
        warnings.append(
            f"[{pid}] 只有部分页有音频，缺第 {missing} 页 —— "
            f"孩子端「连着听」会跳过这些页，确认是故意的吗？"
        )

    listen = {}
    # book_audio：整本一条音轨，和页码对不上，原样搬进包里不切。
    # 牛津树自然拼读就是这样 —— 一条 mp3 里混着拼读练习和故事、逐音停顿，
    # 按静音切出来的段数是页数的三四倍，硬切只会切碎。
    if piece.get("book_audio"):
        src = Path(piece["book_audio"])
        if not src.exists():
            raise SystemExit(f"[{pid}] book_audio 找不到：{src}")
        rel = f"audio/{pid}-book{src.suffix.lower()}"
        (stage / "audio").mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, stage / rel)
        listen = {"mode": "whole", "audio": rel}
        if n_audio:
            warnings.append(
                f"[{pid}] 同时有逐页音频和整本音轨，孩子端会出 3 个听的按钮，"
                f"确认是故意的吗？"
            )
    elif n_audio:
        listen = {"mode": "sequence"}

    out = {
        "id": pid,
        "title": piece["title"],
        "lang": piece.get("lang", "zh-CN"),
        "listen": listen,
        "pages": out_pages,
    }
    if piece.get("cover_page"):
        cp = piece["cover_page"]
        if cp in by_page:
            out["cover"] = take_image(cp, f"images/{pid}-cover.jpg")
        else:
            warnings.append(f"[{pid}] cover_page 第 {cp} 页不存在，已忽略")
    for k in ("level", "note", "source"):
        if piece.get(k):
            out[k] = piece[k]
    return out


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    stage = out_dir / f".stage-{plan['date']}"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)

    warnings = []
    pieces = [build_piece(p, stage, warnings) for p in plan["pieces"]]

    manifest = {
        "format": "reading-diary-pack",
        "version": 1,
        "date": plan["date"],
        "child": plan.get("child", ""),
        "pieces": pieces,
    }
    if plan.get("note"):
        manifest["note"] = plan["note"]
    (stage / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    pack = out_dir / f"{plan['date']}.rdpkg"
    with zipfile.ZipFile(pack, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(stage.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(stage))
    shutil.rmtree(stage)

    print(f"✓ {pack}  ({pack.stat().st_size / 1024:.0f} KB)")
    for p in pieces:
        n_audio = sum(1 for s in p["pages"] if s["audio"])
        n_text = sum(1 for s in p["pages"] if s.get("text"))
        whole = (p.get("listen") or {}).get("audio")
        if n_audio:
            src, btn = f"{n_audio} 页真人音", "听这页 / 连着听"
        elif n_text:
            src, btn = f"{n_text} 页 TTS 文本", "听这页 / 连着听"
        else:
            src, btn = "纯图", "自由翻页"
        if whole:
            src += " ＋ 整本音轨"
            btn = "整本听（边听边翻页）" if btn == "自由翻页" else f"{btn} / 整本听"
        print(f"    {p['id']} {p['title']}｜{len(p['pages'])} 页｜{src}｜{btn}"
              f"{'｜含封面' if p.get('cover') else ''}")
    for w in warnings:
        print(f"  ⚠ {w}")


if __name__ == "__main__":
    main()
