#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把角色卡 JSON + 头像 PNG 打包成 SillyTavern 能直接导入的角色卡。

角色卡的载体是 PNG 的 tEXt 块（这是酒馆从 TavernAI 继承下来的约定）：

    tEXt  keyword=chara  → base64(UTF-8 的 v2 角色 JSON)
    tEXt  keyword=ccv3   → base64(UTF-8 的 v3 角色 JSON)   ← 有 ccv3 时酒馆优先读它

本脚本只依赖标准库（zlib + struct + base64），不需要装 png-chunks-extract 那些 npm 包，
这样改角色卡内容不必回到 Node 侧。

用法
----
    python3 tools/make_card.py \
        --spec card/natsume.card.json \
        --image card/natsume_avatar.png \
        --out "card/四季夏目.png"

    # 只校验 spec（不写文件）
    python3 tools/make_card.py --spec card/natsume.card.json --check

装完卡片后可以用 --verify 读回来确认块写进去了：
    python3 tools/make_card.py --verify "card/四季夏目.png"
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import struct
import sys
import zlib

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


# ---------------------------------------------------------------------------
# 最小 PNG 读写（只处理 tEXt / IHDR / IDAT / IEND，足够角色卡用）
# ---------------------------------------------------------------------------

def _read_chunks(blob: bytes) -> list[tuple[bytes, bytes]]:
    if blob[:8] != PNG_MAGIC:
        raise ValueError("不是 PNG 文件（magic 不对）")
    chunks: list[tuple[bytes, bytes]] = []
    pos = 8
    while pos + 8 <= len(blob):
        (length,) = struct.unpack(">I", blob[pos:pos + 4])
        name = blob[pos + 4:pos + 8]
        data = blob[pos + 8:pos + 8 + length]
        crc = blob[pos + 8 + length:pos + 12 + length]
        expect = struct.pack(">I", zlib.crc32(name + data) & 0xFFFFFFFF)
        if crc != expect:
            raise ValueError("PNG 块 %s 的 CRC 校验失败" % name.decode("ascii", "replace"))
        chunks.append((name, data))
        pos += 12 + length
        if name == b"IEND":
            break
    return chunks


def _write_chunks(chunks: list[tuple[bytes, bytes]]) -> bytes:
    out = io.BytesIO()
    out.write(PNG_MAGIC)
    for name, data in chunks:
        out.write(struct.pack(">I", len(data)))
        out.write(name)
        out.write(data)
        out.write(struct.pack(">I", zlib.crc32(name + data) & 0xFFFFFFFF))
    return out.getvalue()


def _text_chunk(keyword: str, text: str) -> tuple[bytes, bytes]:
    """tEXt：keyword\\0text（Latin-1 存 ASCII 安全；中文用 base64 装，见调用方）"""
    payload = keyword.encode("latin-1") + b"\x00" + text.encode("latin-1")
    return b"tEXt", payload


def _decode_text(data: bytes) -> tuple[str, str]:
    keyword, _, text = data.partition(b"\x00")
    return keyword.decode("latin-1"), text.decode("latin-1")


# ---------------------------------------------------------------------------
# 角色卡打包 / 读取
# ---------------------------------------------------------------------------

def embed(image_path: str, card_json: str) -> bytes:
    """把角色 JSON（v2 结构）写进 PNG，同时写 chara 与 ccv3 两个块。"""
    with open(image_path, "rb") as handle:
        blob = handle.read()
    chunks = _read_chunks(blob)

    # 先清掉旧的角色块，避免重复导入时读到旧数据
    chunks = [
        (name, data) for name, data in chunks
        if not (name == b"tEXt" and _decode_text(data)[0].lower() in ("chara", "ccv3"))
    ]

    v2 = json.loads(card_json)
    v3 = dict(v2)
    v3["spec"] = "chara_card_v3"
    v3["spec_version"] = "3.0"

    new_chunks: list[tuple[bytes, bytes]] = []
    new_chunks.append(_text_chunk("chara", base64.b64encode(card_json.encode("utf-8")).decode("ascii")))
    new_chunks.append(_text_chunk("ccv3", base64.b64encode(
        json.dumps(v3, ensure_ascii=False).encode("utf-8")).decode("ascii")))

    # IEND 之前插入
    index = next((i for i, (name, _) in enumerate(chunks) if name == b"IEND"), len(chunks))
    chunks[index:index] = new_chunks
    return _write_chunks(chunks)


def read_card(image_path: str) -> dict:
    with open(image_path, "rb") as handle:
        chunks = _read_chunks(handle.read())
    found = {}
    for name, data in chunks:
        if name != b"tEXt":
            continue
        keyword, text = _decode_text(data)
        if keyword.lower() in ("chara", "ccv3"):
            found[keyword.lower()] = json.loads(base64.b64decode(text).decode("utf-8"))
    if not found:
        raise ValueError("这张 PNG 里没有 chara / ccv3 块")
    return found.get("ccv3") or found["chara"]


# ---------------------------------------------------------------------------
# 校验
# ---------------------------------------------------------------------------

REQUIRED = ("name", "description", "personality", "scenario", "first_mes", "mes_example")


def validate(spec: dict) -> list[str]:
    problems = []
    for field in REQUIRED:
        if not str(spec.get(field) or "").strip():
            problems.append("缺少必填字段：%s" % field)
    data = spec.get("data")
    if not isinstance(data, dict):
        problems.append("缺少 data 对象（v2 角色卡把内容放在 data 下）")
        return problems
    for field in REQUIRED:
        if not str(data.get(field) or "").strip():
            problems.append("data.%s 为空" % field)
    if "system_prompt" not in data:
        problems.append("data.system_prompt 缺失（这个卡的人设协议就靠它）")
    if len(str(data.get("first_mes") or "")) < 20:
        problems.append("data.first_mes 太短（开场白要有内容）")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description="打包 SillyTavern 角色卡（PNG + tEXt 块）")
    parser.add_argument("--spec", help="角色卡 JSON 路径")
    parser.add_argument("--image", help="头像 PNG 路径")
    parser.add_argument("--out", help="输出 PNG 路径")
    parser.add_argument("--check", action="store_true", help="只校验 spec，不写文件")
    parser.add_argument("--verify", help="读回一张已有角色卡并打印概要")
    args = parser.parse_args()

    if args.verify:
        card = read_card(args.verify)
        data = card.get("data", card)
        print("文件      :", args.verify)
        print("spec      :", card.get("spec", "chara_card_v2"))
        print("名字      :", data.get("name"))
        print("描述字数  :", len(str(data.get("description") or "")))
        print("人设字数  :", len(str(data.get("personality") or "")))
        print("system    :", len(str(data.get("system_prompt") or "")), "字")
        print("开场白    :", str(data.get("first_mes") or "")[:60].replace("\n", " / "))
        print("示例对话  :", len(str(data.get("mes_example") or "")), "字")
        world = (data.get("character_book") or {}).get("entries") or []
        print("世界书条目:", len(world))
        for entry in world:
            print("   -", entry.get("comment"), "| keys:", entry.get("keys"))
        return 0

    if not args.spec:
        parser.error("需要 --spec（或用 --verify）")

    with open(args.spec, encoding="utf-8") as handle:
        spec = json.load(handle)

    problems = validate(spec)
    if problems:
        print("❌ spec 校验未通过：")
        for problem in problems:
            print("   -", problem)
        return 2
    print("✅ spec 校验通过")

    if args.check:
        return 0

    if not args.image or not args.out:
        parser.error("打包需要 --image 与 --out")

    # 文件里存的是顶层即 v2 结构（data 里才是内容），与酒馆的读法一致
    payload = json.dumps(spec, ensure_ascii=False)
    blob = embed(args.image, payload)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "wb") as handle:
        handle.write(blob)
    print("✅ 写出角色卡：%s（%.1f KB）" % (args.out, len(blob) / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
