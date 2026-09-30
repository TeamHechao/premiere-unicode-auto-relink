import gzip
import json
from pathlib import Path
import tempfile
import unittest
import unicodedata
from unittest.mock import patch
from xml.sax.saxutils import escape
import xml.etree.ElementTree as ET

import relink_media as repair


class RepairTests(unittest.TestCase):
    def setUp(self):
        work = Path(__file__).parent / "work"
        work.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=work)
        self.base = Path(self.temp.name)
        self.pack = self.base / "音楽包"
        self.pack.mkdir()
        self.project = self.base / "incoming" / "edit.prproj"
        self.project.parent.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def resolver(self, roots=None):
        return repair.Resolver(self.project, roots or [self.pack], {})

    def xml(self, old):
        value = escape(old)
        return f'''<?xml version="1.0" encoding="UTF-8"?>
<PremiereData Version="3"><Project><AudioFader><CurrentValue>0.332484036684</CurrentValue></AudioFader>
<Caption>字幕 &amp; 未变化</Caption><Media ObjectRef="2"/></Project>
<Media ObjectUID="one"><FilePath>{value}</FilePath><ActualMediaFilePath>{value}</ActualMediaFilePath>
<RelativePath>../old</RelativePath><RelativePath>../old</RelativePath><OfflineReason>5</OfflineReason>
<FileKey>fixed-key</FileKey><Title>original</Title></Media>
<Media ObjectUID="generated"><FilePath>1112293707</FilePath></Media></PremiereData>'''

    def test_decomposed_japanese_folder_and_filename(self):
        folder = self.pack / "ゲーム"
        folder.mkdir()
        target = folder / "ピアノ & 曲.mp3"
        target.write_bytes(b"test media")
        old = unicodedata.normalize("NFD", "/Volumes/ORIGINAL/音楽包/ゲーム/ピアノ & 曲.mp3")
        fixed, report = repair.repair_xml(self.xml(old), self.resolver())
        tree = ET.fromstring(fixed)
        media = tree.find("Media")
        self.assertEqual(media.findtext("FilePath"), str(target))
        self.assertEqual(len(media.findall("RelativePath")), 2)
        self.assertIsNone(media.find("OfflineReason"))
        self.assertIn("0.332484036684", fixed)
        self.assertIn("字幕 &amp; 未变化", fixed)
        self.assertEqual(len(report["changed"]), 1)
        self.assertEqual(report["unresolved"], [])

    def test_different_candidates_are_not_relinked(self):
        other = self.base / "other" / "音楽包"
        other.mkdir(parents=True)
        (self.pack / "clip.mp3").write_bytes(b"AAA")
        (other / "clip.mp3").write_bytes(b"BBB")
        old = "/Volumes/ORIGINAL/音楽包/clip.mp3"
        xml = self.xml(old)
        fixed, report = repair.repair_xml(xml, self.resolver([self.pack, other]))
        self.assertEqual(fixed, xml)
        self.assertEqual(report["changed"], [])
        self.assertEqual(len(report["unresolved"][0]["candidates"]), 2)

    def test_identical_copies_are_accepted(self):
        other = self.base / "other" / "音楽包"
        other.mkdir(parents=True)
        (self.pack / "clip.mp3").write_bytes(b"AAA")
        (other / "clip.mp3").write_bytes(b"AAA")
        _, report = repair.repair_xml(self.xml("/Volumes/X/音楽包/clip.mp3"), self.resolver([self.pack, other]))
        self.assertEqual(len(report["changed"]), 1)

    def test_missing_source_is_preserved(self):
        xml = self.xml("/Users/editor/Desktop/no-such-file.mov")
        fixed, report = repair.repair_xml(xml, self.resolver())
        self.assertEqual(fixed, xml)
        self.assertEqual(len(report["unresolved"]), 1)

    def test_gzip_output_backup_and_repeat_run(self):
        target = self.pack / "ピアノ.mp3"
        target.write_bytes(b"audio")
        raw = gzip.compress(self.xml(unicodedata.normalize("NFD", "/Volumes/X/音楽包/ピアノ.mp3")).encode("utf-8"))
        self.project.write_bytes(raw)
        config = {"media_roots": [str(self.pack)], "mappings": []}
        with patch.object(repair, "ROOT", self.base):
            report = repair.process(self.project, config)
            result = Path(report["output"])
            self.assertEqual(self.project.read_bytes(), raw)
            self.assertEqual((result.parent / "原工程备份.prproj").read_bytes(), raw)
            ET.fromstring(gzip.decompress(result.read_bytes()))
            saved = json.loads((result.parent / "修复清单.json").read_text(encoding="utf-8"))
            self.assertTrue(saved["structure_unchanged"])
            again = repair.process(result, config, dry_run=True)
            self.assertEqual(again["repaired_count"], 0)
            self.assertEqual(again["unresolved_count"], 0)

    def test_explicit_mapping_takes_precedence(self):
        target = self.pack / "clip.mp3"
        target.write_bytes(b"audio")
        resolver = repair.Resolver(self.project, [], {}, [
            {"old_prefix": "/Volumes/X/OldName", "new_root": str(self.pack)}])
        match, _, _ = resolver.resolve("/Volumes/X/OldName/clip.mp3")
        self.assertEqual(match, target)

    def test_duplicate_media_uid_is_rejected(self):
        xml = self.xml("/Volumes/X/音楽包/clip.mp3")
        xml = xml.replace('</PremiereData>', '<Media ObjectUID="one"><FilePath>/other.mp3</FilePath></Media></PremiereData>')
        with self.assertRaisesRegex(ValueError, "重复媒体身份"):
            repair.repair_xml(xml, self.resolver())

    def test_comment_lookalike_is_preserved(self):
        (self.pack / "clip.mp3").write_bytes(b"audio")
        comment = '<!--<Media ObjectUID="one"><FilePath>/Volumes/X/音楽包/clip.mp3</FilePath></Media>-->'
        xml = self.xml("/Volumes/X/音楽包/clip.mp3").replace('<Project>', '<Project>' + comment)
        fixed, report = repair.repair_xml(xml, self.resolver())
        self.assertIn(comment, fixed)
        self.assertEqual(len(report["changed"]), 1)

    def test_empty_path_elements_and_nested_metadata_are_preserved(self):
        target = self.pack / "clip.mp3"
        target.write_bytes(b"audio")
        xml = self.xml("/Volumes/X/音楽包/clip.mp3")
        xml = xml.replace('<RelativePath>../old</RelativePath>', '<RelativePath/>')
        xml = xml.replace('<OfflineReason>5</OfflineReason>', '<OfflineReason/>')
        xml = xml.replace('<FileKey>', '<Metadata><FilePath>leave-this-alone</FilePath></Metadata><FileKey>')
        fixed, _ = repair.repair_xml(xml, self.resolver())
        media = ET.fromstring(fixed).find("Media")
        self.assertEqual(media.findtext("Metadata/FilePath"), "leave-this-alone")
        self.assertEqual([node.text for node in media.findall("RelativePath")], [str(target)] * 2)
        self.assertIsNone(media.find("OfflineReason"))

    def test_nested_media_or_non_text_paths_are_rejected(self):
        for replacement in ['<Metadata><Media ObjectUID="nested"/></Metadata><FileKey>',
                            '<RelativePath><Unknown>text</Unknown></RelativePath><FileKey>']:
            xml = self.xml("/Volumes/X/音楽包/clip.mp3").replace('<FileKey>', replacement)
            with self.assertRaisesRegex(ValueError, "嵌套媒体|非文本路径"):
                repair.repair_xml(xml, self.resolver())

    def test_candidate_changed_before_output_stops_without_writing(self):
        target = self.pack / "clip.mp3"
        target.write_bytes(b"audio")
        original = self.xml("/Volumes/X/音楽包/clip.mp3").encode("utf-8")
        self.project.write_bytes(original)
        original_snapshot = repair.file_snapshot
        calls = 0

        def raced_snapshot(path):
            nonlocal calls
            result = original_snapshot(path)
            calls += 1
            if calls == 1:
                target.write_bytes(b"replaced with different audio")
            return result

        with patch.object(repair, "ROOT", self.base), patch.object(repair, "file_snapshot", side_effect=raced_snapshot):
            with self.assertRaisesRegex(ValueError, "候选文件.*改变"):
                repair.process(self.project, {"media_roots": [str(self.pack)]})
        self.assertEqual(self.project.read_bytes(), original)
        self.assertFalse((self.base / "outputs").exists())

    def test_unicode_casefold_does_not_match_unrelated_names(self):
        (self.pack / "straße.mp3").write_bytes(b"audio")
        match, _, _ = self.resolver().resolve("/Volumes/X/音楽包/strasse.mp3")
        self.assertIsNone(match)

    def test_malformed_configuration_is_rejected(self):
        for config in [{"media_roots": "not-an-array"}, {"media_roots": [123]},
                       {"media_roots": ["relative/path"]}, {"mappings": [{"old_prefix": "x", "new_root": "relative"}]}]:
            with self.assertRaises(ValueError):
                repair.validate_config(config)

    def test_dtd_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "DTD"):
            repair.parse_xml('<!DOCTYPE PremiereData [<!ENTITY x "a">]><PremiereData/>')


if __name__ == "__main__":
    unittest.main()
