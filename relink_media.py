"""Conservative, offline Premiere media-path repair; Python standard library only."""
from __future__ import annotations

import argparse
from copy import deepcopy
import ctypes
from datetime import datetime
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import unicodedata
import uuid
import xml.etree.ElementTree as ET
from xml.parsers import expat

ROOT = Path(__file__).resolve().parent
PATH_TAGS = {"FilePath", "ActualMediaFilePath", "RelativePath"}


def normal(value: str) -> str:
    return unicodedata.normalize("NFC", value)


def plain_entry(path: Path):
    info = path.lstat()
    linked = stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)
    return info, linked


def plain_directory(path: Path) -> bool:
    try:
        for component in [*reversed(path.parents), path]:
            info, linked = plain_entry(component)
            if linked or not stat.S_ISDIR(info.st_mode):
                return False
        return True
    except (FileNotFoundError, NotADirectoryError):
        return False


def regular_file(path: Path) -> bool:
    try:
        info, linked = plain_entry(path)
        return not linked and stat.S_ISREG(info.st_mode) and info.st_size > 0
    except (FileNotFoundError, NotADirectoryError):
        return False


def file_snapshot(path: Path) -> list[int]:
    info, linked = plain_entry(path)
    if linked or not stat.S_ISREG(info.st_mode) or info.st_size <= 0:
        raise ValueError("候选不是非空普通文件")
    return [info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_dev, info.st_ino]


def validate_config(value: dict) -> dict:
    if not isinstance(value, dict) or not isinstance(value.get("media_roots", []), list):
        raise ValueError("media_roots 必须是目录数组")
    roots = value.get("media_roots", [])
    mappings = value.get("mappings", [])
    if not isinstance(mappings, list):
        raise ValueError("mappings 必须是数组")
    for root in roots:
        if not isinstance(root, str) or not root or not Path(root).is_absolute() or ".." in Path(root).parts or "\0" in root:
            raise ValueError("素材根目录必须是无越界组件的绝对路径")
    for mapping in mappings:
        if not isinstance(mapping, dict) or not isinstance(mapping.get("old_prefix"), str) or not mapping["old_prefix"]:
            raise ValueError("旧路径映射无效")
        root = mapping.get("new_root")
        if not isinstance(root, str) or not Path(root).is_absolute() or ".." in Path(root).parts or "\0" in root:
            raise ValueError("映射目标必须是无越界组件的绝对路径")
    return {"media_roots": list(roots), "mappings": list(mappings)}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_digest(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def windows_volumes() -> dict[str, str]:
    if os.name != "nt":
        return {}
    result = {}
    kernel = ctypes.windll.kernel32
    mask = kernel.GetLogicalDrives()
    for n in range(26):
        if not mask & (1 << n):
            continue
        drive = chr(65 + n) + ":\\"
        label = ctypes.create_unicode_buffer(261)
        if kernel.GetVolumeInformationW(drive, label, len(label), None, None, None, None, 0):
            result[drive] = label.value
    return result


class Resolver:
    def __init__(self, source: Path, roots: list[Path], volumes: dict[str, str], mappings=None):
        self.source = source
        self.roots = roots
        self.volumes = volumes
        self.mappings = mappings or []
        self.cache = {}

    def walk(self, base: Path, parts: list[str]) -> list[Path]:
        # Component-by-component lookup avoids crawling entire drives or media libraries.
        if any(p in {"..", ".", ""} for p in parts):
            return []
        candidates = [base]
        for part in parts:
            next_candidates = []
            for parent in candidates:
                if not plain_directory(parent):
                    continue
                key = str(parent)
                if key not in self.cache:
                    try:
                        self.cache[key] = list(parent.iterdir())
                    except (FileNotFoundError, NotADirectoryError):
                        self.cache[key] = []
                next_candidates.extend(p for p in self.cache[key] if normal(p.name) == normal(part))
            candidates = next_candidates
            if not candidates:
                break
        return [p for p in candidates if regular_file(p)]

    def choose(self, candidates: list[Path], reason: str):
        unique = {str(p): p for p in candidates}
        values = sorted(unique.values(), key=str)
        if not values:
            return None, "未找到", []
        if len(values) == 1:
            return values[0], reason, values
        if len({p.stat().st_size for p in values}) == 1 and len({file_digest(p) for p in values}) == 1:
            return values[0], reason + "；多个副本SHA-256一致", values
        return None, "多个不同内容的候选，需人工选择", values

    def resolve(self, value: str):
        path = Path(value)
        if path.is_absolute() and regular_file(path) and plain_directory(path.parent):
            return path, "原路径存在", [path]
        unix = value.replace("\\", "/")
        # Explicit mappings, when supplied, are authoritative; never silently ignore a broken mapping.
        for mapping in self.mappings:
            prefix = mapping["old_prefix"].replace("\\", "/").rstrip("/")
            if normal(unix).startswith(normal(prefix) + "/"):
                parts = unix.split("/")[len(prefix.split("/")):]
                return self.choose(self.walk(Path(mapping["new_root"]), parts), "指定目录映射")
        mac = re.match(r"^/Volumes/([^/]+)/(.*)$", unix)
        win = re.match(r"^([A-Za-z]:)/(.*)$", unix)
        preferred = []
        if mac:
            label, relative = mac.groups()
            for root, actual_label in self.volumes.items():
                if normal(label) == normal(actual_label):
                    preferred.extend(self.walk(Path(root), relative.split("/")))
        elif win:
            drive, relative = win.groups()
            if drive.upper() + "\\" in self.volumes:
                preferred.extend(self.walk(Path(drive + "/"), relative.split("/")))
        else:
            relative = unix.lstrip("/")
        if preferred:
            return self.choose(preferred, "原磁盘完整相对路径及Unicode匹配")
        parts = relative.split("/")
        candidates = []
        # Search only beneath explicitly configured media roots or the input project's folder.
        for root in [self.source.parent, *self.roots]:
            for index, component in enumerate(parts):
                if normal(component) == normal(root.name):
                    candidates.extend(self.walk(root, parts[index + 1:]))
        return self.choose(candidates, "素材根目录完整后缀及Unicode匹配")


def signature(element, changed_ids, inside=False):
    inside = inside or (element.tag == "Media" and element.get("ObjectUID") in changed_ids)
    if inside and element.tag in PATH_TAGS | {"OfflineReason"}:
        return None
    return (element.tag, tuple(sorted(element.attrib.items())), (element.text or "").strip(),
            tuple(item for child in element if (item := signature(child, changed_ids, inside)) is not None))


def parse_xml(xml: str):
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", xml, flags=re.IGNORECASE):
        raise ValueError("不支持带 DTD 或实体声明的工程")
    return ET.fromstring(xml, parser=ET.XMLParser(target=ET.TreeBuilder(insert_comments=True, insert_pis=True)))


def rewrite_media(xml: str, nodes: dict, changes: dict) -> str:
    # Expat locates actual XML elements (not lookalikes inside comments); only
    # changed Media fragments are serialized. Everything outside them is byte-preserved.
    data = xml.encode("utf-8")
    parser = expat.ParserCreate()
    stack, spans = [], []

    def start(name, attributes):
        stack.append((name, attributes.get("ObjectUID"), parser.CurrentByteIndex))

    def end(name):
        tag, uid, begin = stack.pop()
        if tag == "Media" and uid in changes:
            position = parser.CurrentByteIndex
            if data[position:position + 2] != b"</":
                raise ValueError("媒体元素不受支持")
            spans.append((begin, data.index(b">", position) + 1, uid))

    parser.StartElementHandler, parser.EndElementHandler = start, end
    parser.Parse(data, True)
    if len(spans) != len(changes) or {uid for _, _, uid in spans} != set(changes):
        raise ValueError("未能精准匹配全部媒体节点")
    for begin, finish, uid in sorted(spans, reverse=True):
        media = deepcopy(nodes[uid])
        media.tail = None
        for tag in sorted(PATH_TAGS):
            children = media.findall(tag)
            if not children:
                children = [ET.SubElement(media, tag)]
            for child in children:
                child.text = changes[uid]["new"]
        for child in list(media):
            if child.tag == "OfflineReason":
                media.remove(child)
        data = data[:begin] + ET.tostring(media, encoding="utf-8") + data[finish:]
    return data.decode("utf-8")


def repair_xml(xml: str, resolver: Resolver):
    before = parse_xml(xml)
    if before.tag != "PremiereData":
        raise ValueError("不是受支持的 Premiere XML 工程")
    changes, unresolved, nodes = {}, [], {}
    counts = {"already_online": 0, "internal_media_skipped": 0}
    for media in before.iter("Media"):
        old = media.findtext("FilePath") or ""
        uid = media.get("ObjectUID")
        if uid:
            if uid in nodes:
                raise ValueError("工程中出现重复媒体身份")
            if len(list(media.iter("Media"))) != 1 or any(list(child) for child in media if child.tag in PATH_TAGS):
                raise ValueError("工程含嵌套媒体或非文本路径，不受支持")
            nodes[uid] = media
        if not uid or not old:
            continue
        # Numeric paths and generated media are not external file references.
        if not (old.startswith("/") or re.match(r"^[A-Za-z]:[\\/]", old) or old.startswith("\\\\")):
            counts["internal_media_skipped"] += 1
            continue
        new, reason, candidates = resolver.resolve(old)
        if new is None:
            unresolved.append({"old": old, "reason": reason, "candidates": [str(p) for p in candidates]})
            continue
        if str(new) == old and media.find("OfflineReason") is None:
            counts["already_online"] += 1
            continue
        changes[uid] = {"old": old, "new": str(new), "reason": reason,
                        "bytes": new.stat().st_size, "candidate_snapshot": file_snapshot(new)}

    after_xml = rewrite_media(xml, nodes, changes) if changes else xml
    after = parse_xml(after_xml)
    if signature(before, changes) != signature(after, changes):
        raise ValueError("检测到非路径数据变化；没有输出工程")
    for media in after.iter("Media"):
        uid = media.get("ObjectUID")
        if uid in changes:
            for tag in PATH_TAGS:
                if any(e.text != changes[uid]["new"] for e in media.findall(tag)):
                    raise ValueError(f"路径读回失败：{uid}")
            if media.find("OfflineReason") is not None or not Path(changes[uid]["new"]).is_file():
                raise ValueError(f"媒体验证失败：{uid}")
    return after_xml, {"changed": list(changes.values()), "unresolved": unresolved,
                       "structure_unchanged": True, "premiere_runtime_verified": False, **counts}


def process(source: Path, config: dict, dry_run=False):
    config = validate_config(config)
    source = source.resolve(strict=True)
    if source.suffix.lower() != ".prproj":
        raise ValueError("请选择 .prproj 工程文件")
    raw = source.read_bytes()
    compressed = raw.startswith(b"\x1f\x8b")
    xml = (gzip.decompress(raw) if compressed else raw).decode("utf-8-sig")
    resolver = Resolver(source, [Path(p) for p in config["media_roots"]], windows_volumes(), config.get("mappings"))
    fixed, report = repair_xml(xml, resolver)
    report.update(source=str(source), source_sha256=digest(raw), repaired_count=len(report["changed"]),
                  unresolved_count=len(report["unresolved"]))
    if source.read_bytes() != raw:
        raise ValueError("原工程在处理期间发生变化，请保存后重试")
    if dry_run:
        return report
    for change in report["changed"]:
        if file_snapshot(Path(change["new"])) != change["candidate_snapshot"]:
            raise ValueError("候选文件在处理期间改变，请重试")
    run = ROOT / "outputs" / (datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:6])
    run.mkdir(parents=True, exist_ok=False)
    backup = run / "原工程备份.prproj"
    backup.write_bytes(raw)
    if backup.read_bytes() != raw:
        raise ValueError("原工程备份读回失败")
    result = None
    if report["changed"]:
        result = run / (source.stem + "_Windows链接修复.prproj")
        output_bytes = gzip.compress(fixed.encode("utf-8"), mtime=0) if compressed else fixed.encode("utf-8")
        result.write_bytes(output_bytes)
        readback = result.read_bytes()
        if (gzip.decompress(readback) if compressed else readback).decode("utf-8") != fixed:
            raise ValueError("输出工程读回失败")
        report.update(output=str(result), output_sha256=digest(readback))
    report["source_unchanged"] = source.read_bytes() == raw
    (run / "修复清单.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = ["PR 素材链接修复结果", "", f"输入：{source}", f"修复：{len(report['changed'])} 条",
             f"仍待处理：{len(report['unresolved'])} 条", f"输出：{result or '没有路径变化，未生成重复工程'}",
             "", "已核对时间线、音量、字幕及其他非路径结构一致。尚未在 Premiere 中验收。",
             "请在 Premiere 打开修复版，检查素材在线和音画，再保存；原工程备份保留在本目录。"]
    if not report["source_unchanged"]:
        lines += ["注意：输出期间原工程有更新，本副本对应处理开始时的保存版本。"]
    lines += ["", "仍待处理的素材："]
    lines += [f"- {row['old']}\n  {row['reason']}" for row in report["unresolved"]]
    (run / "修复结果.txt").write_text("\n".join(lines), encoding="utf-8-sig")
    report["result_directory"] = str(run)
    return report


def main():
    parser = argparse.ArgumentParser(description="修复 Premiere 的 Mac/Windows 路径与日文字符差异，生成副本")
    parser.add_argument("projects", nargs="*")
    parser.add_argument("--dry-run", action="store_true", help="只检查，不写文件")
    parser.add_argument("--pause", action="store_true")
    parser.add_argument("--media-root", action="append", default=[])
    parser.add_argument("--config", type=Path, help="JSON configuration file; defaults to 素材位置.json when present")
    args = parser.parse_args()
    config_path = args.config or (ROOT / "素材位置.json")
    if args.config and not config_path.is_file():
        parser.error("指定的配置文件不存在")
    try:
        if config_path.exists():
            config = json.loads(config_path.read_text(encoding="utf-8-sig"))
        else:
            # The public package intentionally does not contain a machine-specific config.
            config = {"media_roots": [], "mappings": []}
        config = validate_config(config)
        config["media_roots"].extend(args.media_root)
        config = validate_config(config)
    except (ValueError, OSError) as exc:
        parser.error(str(exc))
    if not config["media_roots"] and not config["mappings"]:
        parser.error("请用 --media-root 或 --config 指定至少一个素材根目录")
    if not args.projects:
        import tkinter as tk
        from tkinter import filedialog
        window = tk.Tk()
        window.withdraw()
        args.projects = list(filedialog.askopenfilenames(title="选择已保存的 Premiere 工程", filetypes=[("Premiere 工程", "*.prproj")]))
        window.destroy()
    exit_code = 0
    for name in args.projects:
        try:
            report = process(Path(name), config, args.dry_run)
            print(f"\n{Path(name).name}\n修复 {report['repaired_count']} 条；仍待处理 {report['unresolved_count']} 条。")
            if args.dry_run:
                print(json.dumps(report, ensure_ascii=False, indent=2))
            else:
                print(f"结果目录：{report['result_directory']}")
        except Exception as exc:
            exit_code = 1
            print(f"处理失败：{name}\n{exc}", file=sys.stderr)
    if args.pause:
        input("\n按回车关闭窗口……")
    return exit_code


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
