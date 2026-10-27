#!/usr/bin/env python3
"""把包里的贴图缩到指定最长边（默认 2048），**只处理副本，不碰源模型**。

为什么需要：常见 Live2D 模型带 4096²/8192² 贴图，一张 8192² RGBA 在显存里就是 256 MB；
而桌宠在屏幕上只有 180~260 px 高。原尺寸上传纯属浪费，还拖慢首帧。

缩放要点：
  - 用预乘 alpha（RGBa）做重采样，否则透明边缘会出现黑边
  - 保持长宽比，LANCZOS
  - 只处理 .png；其它格式原样保留，并在结果里标 skipped

用法：
  python tools/shrink-textures.py --dir <textures 目录> --max 2048 [--json]

输出（--json）：一行 JSON
  {"max": 2048, "files": [{file, from:[w,h], to:[w,h], bytesFrom, bytesAfter}],
   "skipped": [...], "bytesBefore": N, "bytesAfter": N}
"""
import argparse
import io
import json
import os
import sys

try:
    from PIL import Image
except ImportError:  # 没有 Pillow 就把原始信息报回去，让调用方决定怎么办
    print(json.dumps({"ok": False, "error": "Pillow 未安装（pip install pillow）"}))
    sys.exit(3)


def premultiplied_resize(im, nw, nh):
    """预乘 alpha 重采样，避免透明边缘出现黑边。"""
    if im.mode in ("RGBA", "LA") or "transparency" in im.info or im.mode == "P":
        im = im.convert("RGBA")
        return im.convert("RGBa").resize((nw, nh), Image.LANCZOS).convert("RGBA")
    return im.convert("RGB").resize((nw, nh), Image.LANCZOS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--max", type=int, default=2048)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    limit = max(64, int(args.max))
    out = {"ok": True, "max": limit, "files": [], "skipped": [],
           "bytesBefore": 0, "bytesAfter": 0}

    names = sorted(n for n in os.listdir(args.dir) if os.path.isfile(os.path.join(args.dir, n)))
    for name in names:
        path = os.path.join(args.dir, name)
        size_before = os.path.getsize(path)
        out["bytesBefore"] += size_before

        if not name.lower().endswith(".png"):
            out["skipped"].append({"file": name, "why": "不是 png"})
            out["bytesAfter"] += size_before
            continue

        try:
            with Image.open(path) as im:
                im.load()
                w, h = im.size
                longest = max(w, h)
                if longest <= limit:
                    out["bytesAfter"] += size_before
                    continue
                k = limit / float(longest)
                nw, nh = max(1, round(w * k)), max(1, round(h * k))
                resized = premultiplied_resize(im, nw, nh)
        except Exception as err:  # 单个文件坏掉不该毁掉整个构建
            out["skipped"].append({"file": name, "why": f"读图失败: {err}"})
            out["bytesAfter"] += size_before
            continue

        buf = io.BytesIO()
        resized.save(buf, "PNG", optimize=True)
        data = buf.getvalue()
        # 万一压完反而变大（小图/高压缩原图），保留原文件
        if len(data) >= size_before:
            out["bytesAfter"] += size_before
            out["skipped"].append({"file": name, "why": "重编码没变便宜"})
            continue

        with open(path, "wb") as fh:
            fh.write(data)
        out["bytesAfter"] += len(data)
        out["files"].append({
            "file": name, "from": [w, h], "to": [nw, nh],
            "bytesFrom": size_before, "bytesAfter": len(data),
        })

    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
