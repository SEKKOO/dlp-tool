#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import posixpath
import re
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Dict, Iterable, List, Sequence
from xml.etree import ElementTree as ET


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_TEMPLATE_DIR = Path("templates")
DEFAULT_TEMPLATE_NAME = "rule-import-template.xlsx"
DEFAULT_OUTPUT_JSON = Path(".session") / "excel-import" / "rule-config.from-excel.json"
DEFAULT_BROWSER_BATCH_DIR = Path(".session") / "excel-import" / "browser-batch"

XML_NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "doc_rel": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pkg_rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}

DOC_REL_ID = "{%s}id" % XML_NS["doc_rel"]
PREFERRED_SHEETS = ("Rules", "rules", "规则", "规则库", "导入模板")

HEADER_ALIASES = {
    "name": {"name", "rule_name", "规则名称", "规则名"},
    "ruleType": {"ruletype", "rule_type", "规则类型", "分类"},
    "description": {"description", "desc", "描述", "备注"},
    "level": {"level", "数据级别", "密级", "等级"},
    "enable": {"enable", "enabled", "是否启用", "启用", "开启识别"},
    "fileContentEnabled": {
        "filecontentenabled",
        "file_content_enabled",
        "文件内容识别",
        "文件内容",
        "文件内容开关",
    },
    "matchMode": {"matchmode", "match_mode", "匹配关系", "关系", "满足关系"},
    "matchKind": {
        "matchkind",
        "match_kind",
        "匹配类型",
        "正文匹配类型",
        "文件正文匹配类型",
    },
    "matchValue": {
        "matchvalue",
        "match_value",
        "匹配值",
        "匹配内容",
        "关键词",
        "文件正文匹配值",
    },
    "usageAudit": {"usageaudit", "usage_audit", "audit", "审计", "支持审计", "规则用途审计"},
    "usageApi": {"usageapi", "usage_api", "api", "支持api", "支持API", "规则用途api", "规则用途API"},
    "resourceGroupIds": {
        "resourcegroupids",
        "resource_group_ids",
        "资源组id",
        "资源组ids",
        "资源组ID",
        "资源组IDs",
    },
}

REQUIRED_HEADERS = ("name", "ruleType", "level", "matchValue")


def stringify(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def normalize_header(value: object) -> str:
    text = stringify(value).strip().lower()
    return re.sub(r"[\s_\-/:]+", "", text)


def normalize_alias_map() -> Dict[str, str]:
    result: Dict[str, str] = {}
    for canonical, aliases in HEADER_ALIASES.items():
        for alias in aliases:
            result[normalize_header(alias)] = canonical
    return result


CANONICAL_HEADERS = normalize_alias_map()


def is_blank(value: object) -> bool:
    return stringify(value).strip() == ""


def parse_bool(value: object, *, default: bool | None = None) -> bool | None:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)

    text = stringify(value).strip().lower()
    if not text:
        return default

    truthy = {"1", "true", "yes", "y", "on", "enable", "enabled", "是", "开", "开启", "启用"}
    falsy = {"0", "false", "no", "n", "off", "disable", "disabled", "否", "关", "关闭", "停用", "禁用"}

    if text in truthy:
        return True
    if text in falsy:
        return False
    raise ValueError(f"无法识别布尔值: {value}")


def parse_level(value: object) -> str:
    level = stringify(value).strip().upper()
    if not re.fullmatch(r"S[1-4]", level):
        raise ValueError(f"不支持的数据级别: {value}")
    return level


def parse_match_mode(value: object) -> str:
    text = stringify(value).strip()
    if not text:
        return "满足所有"

    normalized = text.lower()
    if normalized in {"and", "all", "满足所有"}:
        return "满足所有"
    if normalized in {"or", "any", "满足任一"}:
        return "满足任一"
    raise ValueError(f"不支持的匹配关系: {value}")


def parse_match_kind(value: object) -> str:
    text = stringify(value).strip()
    if not text:
        return "关键词"

    normalized = text.lower()
    if normalized in {"关键词", "keyword", "keywords"}:
        return "关键词"
    raise ValueError(f"当前仅支持匹配类型为关键词: {value}")


def parse_resource_group_ids(value: object) -> List[str]:
    text = stringify(value).strip()
    if not text:
        return []
    return [item for item in re.split(r"[\s,，;；]+", text) if item]


def excel_column_index(cell_ref: str) -> int:
    letters = "".join(ch for ch in cell_ref if ch.isalpha()).upper()
    value = 0
    for char in letters:
        value = value * 26 + (ord(char) - ord("A") + 1)
    return value


def xml_text(node: ET.Element | None) -> str:
    if node is None:
        return ""
    return "".join(node.itertext())


def parse_shared_strings(zf: zipfile.ZipFile) -> List[str]:
    try:
        root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    except KeyError:
        return []

    shared_strings: List[str] = []
    for item in root.findall("main:si", XML_NS):
        parts = [text.text or "" for text in item.findall(".//main:t", XML_NS)]
        shared_strings.append("".join(parts))
    return shared_strings


def normalize_zip_path(target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join("xl", target))


def parse_workbook_sheets(zf: zipfile.ZipFile) -> List[Dict[str, str]]:
    workbook = ET.fromstring(zf.read("xl/workbook.xml"))
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))

    rel_map = {
        rel.attrib["Id"]: normalize_zip_path(rel.attrib["Target"])
        for rel in rels.findall("pkg_rel:Relationship", XML_NS)
    }

    sheets: List[Dict[str, str]] = []
    for sheet in workbook.findall("main:sheets/main:sheet", XML_NS):
        rel_id = sheet.attrib.get(DOC_REL_ID)
        target = rel_map.get(rel_id or "")
        if not target:
            continue
        sheets.append({"name": sheet.attrib.get("name", ""), "path": target})
    return sheets


def parse_cell_value(cell: ET.Element, shared_strings: Sequence[str]) -> object:
    cell_type = cell.attrib.get("t")
    value_node = cell.find("main:v", XML_NS)

    if cell_type == "inlineStr":
        inline = cell.find("main:is", XML_NS)
        return xml_text(inline).strip()
    if cell_type == "s":
        if value_node is None or value_node.text is None:
            return ""
        index = int(value_node.text)
        return shared_strings[index]
    if cell_type == "b":
        return value_node is not None and value_node.text == "1"
    if cell_type == "str":
        return value_node.text if value_node is not None and value_node.text is not None else ""
    if value_node is None or value_node.text is None:
        return ""

    raw = value_node.text
    if re.fullmatch(r"-?\d+", raw):
        return int(raw)
    if re.fullmatch(r"-?\d+\.\d+", raw):
        return float(raw)
    return raw


def parse_sheet_rows(
    zf: zipfile.ZipFile, sheet_path: str, shared_strings: Sequence[str]
) -> List[tuple[int, Dict[int, object]]]:
    sheet = ET.fromstring(zf.read(sheet_path))
    sheet_data = sheet.find("main:sheetData", XML_NS)
    if sheet_data is None:
        return []

    rows: List[tuple[int, Dict[int, object]]] = []
    for fallback_index, row in enumerate(sheet_data.findall("main:row", XML_NS), start=1):
        row_data: Dict[int, object] = {}
        for cell in row.findall("main:c", XML_NS):
            reference = cell.attrib.get("r", "")
            index = excel_column_index(reference)
            row_data[index] = parse_cell_value(cell, shared_strings)
        row_number = int(row.attrib.get("r", fallback_index))
        rows.append((row_number, row_data))
    return rows


def choose_sheet_name(sheet_names: Sequence[str], requested: str | None) -> str:
    if not sheet_names:
        raise ValueError("Excel 中没有可读取的工作表。")

    if requested:
        for name in sheet_names:
            if name == requested:
                return name
        raise ValueError(f'未找到工作表 "{requested}"，可选值: {", ".join(sheet_names)}')

    for preferred in PREFERRED_SHEETS:
        if preferred in sheet_names:
            return preferred
    return sheet_names[0]


def load_table_from_excel(
    excel_path: Path, sheet_name: str | None
) -> tuple[str, List[tuple[int, Dict[str, object]]]]:
    if excel_path.suffix.lower() not in {".xlsx", ".xlsm"}:
        raise ValueError(f"当前只支持 .xlsx/.xlsm 模版文件: {excel_path}")

    with zipfile.ZipFile(excel_path) as zf:
        shared_strings = parse_shared_strings(zf)
        sheets = parse_workbook_sheets(zf)
        sheet_names = [sheet["name"] for sheet in sheets]
        active_sheet_name = choose_sheet_name(sheet_names, sheet_name)
        target_sheet = next(sheet for sheet in sheets if sheet["name"] == active_sheet_name)
        rows = parse_sheet_rows(zf, target_sheet["path"], shared_strings)

    header_row_number = None
    header_row = None
    for row_number, row in rows:
        if any(not is_blank(value) for value in row.values()):
            header_row_number = row_number
            header_row = row
            break
    if header_row is None:
        raise ValueError(f"Excel 模版 {excel_path} 中没有表头。")

    headers: Dict[int, str] = {}
    for column_index, raw_header in sorted(header_row.items()):
        if is_blank(raw_header):
            continue
        canonical = CANONICAL_HEADERS.get(normalize_header(raw_header))
        if canonical:
            headers[column_index] = canonical

    missing_headers = [item for item in REQUIRED_HEADERS if item not in headers.values()]
    if missing_headers:
        raise ValueError(
            "Excel 表头缺少必填列: "
            + ", ".join(missing_headers)
            + "。支持列包括: "
            + ", ".join(sorted(HEADER_ALIASES))
        )

    data_started = False
    table_rows: List[tuple[int, Dict[str, object]]] = []
    for row_number, row in rows:
        if row_number == header_row_number:
            data_started = True
            continue
        if not data_started:
            continue

        mapped = {headers[idx]: row.get(idx, "") for idx in headers}
        if all(is_blank(value) for value in mapped.values()):
            continue
        table_rows.append((row_number, mapped))

    if not table_rows:
        raise ValueError(f"Excel 模版 {excel_path} 中没有规则数据行。")

    return active_sheet_name, table_rows


def row_to_rule(row: Dict[str, object], row_number: int) -> Dict[str, object]:
    name = stringify(row.get("name")).strip()
    rule_type = stringify(row.get("ruleType")).strip()
    level = parse_level(row.get("level"))
    match_value = stringify(row.get("matchValue")).strip()

    if not name:
        raise ValueError(f"第 {row_number} 行缺少规则名称。")
    if not rule_type:
        raise ValueError(f"第 {row_number} 行缺少规则类型。")
    if not match_value:
        raise ValueError(f"第 {row_number} 行缺少匹配值。")

    file_content_enabled = parse_bool(row.get("fileContentEnabled"), default=True)
    if file_content_enabled is False:
        raise ValueError(f"第 {row_number} 行的文件内容识别必须为启用，当前脚本暂不支持关闭。")

    rule: Dict[str, object] = {
        "name": name,
        "ruleType": rule_type,
        "description": stringify(row.get("description")).strip(),
        "level": level,
        "enable": parse_bool(row.get("enable"), default=True),
        "conditions": {
            "fileContent": {
                "enabled": file_content_enabled,
                "bodyMatch": {
                    "mode": parse_match_mode(row.get("matchMode")),
                    "kind": parse_match_kind(row.get("matchKind")),
                    "value": match_value,
                },
            }
        },
        "usage": {
            "audit": parse_bool(row.get("usageAudit"), default=True),
            "api": parse_bool(row.get("usageApi"), default=True),
        },
    }

    resource_group_ids = parse_resource_group_ids(row.get("resourceGroupIds"))
    if resource_group_ids:
        rule["resourceGroupIds"] = resource_group_ids

    return rule


def extract_match_value(rule: Dict[str, object]) -> str:
    body_match = (
        rule.get("conditions", {})
        .get("fileContent", {})
        .get("bodyMatch", {})
    )
    return stringify(body_match.get("value")).strip()


def resolve_excel_path(explicit_path: str | None, template_dir: Path) -> Path:
    if explicit_path:
        excel_path = Path(explicit_path).expanduser().resolve()
        if not excel_path.exists():
            raise FileNotFoundError(f"Excel 模版不存在: {excel_path}")
        return excel_path

    candidates = sorted(
        [
            path
            for path in template_dir.glob("*")
            if path.is_file() and path.suffix.lower() in {".xlsx", ".xlsm"}
        ]
    )
    if not candidates:
        raise FileNotFoundError(
            f"未在模板目录中找到 Excel 文件: {template_dir}。"
            f" 可先执行 `python3 {Path(__file__).name} --init-template` 生成模板。"
        )

    default_candidate = template_dir / DEFAULT_TEMPLATE_NAME
    if default_candidate in candidates:
        return default_candidate.resolve()

    if len(candidates) > 1:
        names = ", ".join(path.name for path in candidates)
        raise FileNotFoundError(f"模板目录中有多个 Excel 文件，请使用 --excel 指定: {names}")

    return candidates[0].resolve()


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def escape_xml(value: object) -> str:
    text = stringify(value)
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def build_sheet_xml(sheet_name: str, rows: Iterable[Sequence[object]]) -> str:
    rows = list(rows)
    row_xml: List[str] = []
    for row_index, row in enumerate(rows, start=1):
        cell_xml: List[str] = []
        for column_index, value in enumerate(row, start=1):
            cell_ref = f"{column_name(column_index)}{row_index}"
            if is_blank(value):
                continue
            cell_xml.append(
                f'<c r="{cell_ref}" t="inlineStr"><is><t>{escape_xml(value)}</t></is></c>'
            )
        row_xml.append(f'<row r="{row_index}">{"".join(cell_xml)}</row>')

    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<dimension ref=\"A1:L{len(rows) or 1}\"/>"
        '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
        '<sheetFormatPr defaultRowHeight="15"/>'
        f"<sheetData>{''.join(row_xml)}</sheetData>"
        "</worksheet>"
    )


def column_name(index: int) -> str:
    letters: List[str] = []
    current = index
    while current > 0:
        current, remainder = divmod(current - 1, 26)
        letters.append(chr(ord("A") + remainder))
    return "".join(reversed(letters))


def create_template_excel(template_path: Path) -> None:
    template_path.parent.mkdir(parents=True, exist_ok=True)
    headers = [
        "规则名称",
        "规则类型",
        "描述",
        "数据级别",
        "是否启用",
        "文件内容识别",
        "匹配关系",
        "匹配类型",
        "匹配值",
        "支持审计",
        "支持API",
        "资源组ID",
    ]
    sample_row = [
        "示例规则1",
        "通用类",
        "可选描述",
        "S2",
        "是",
        "是",
        "满足所有",
        "关键词",
        "ER图",
        "是",
        "是",
        "",
    ]

    sheet_xml = build_sheet_xml("Rules", [headers, sample_row])
    workbook_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Rules" sheetId="1" r:id="rId1"/></sheets>'
        "</workbook>"
    )
    workbook_rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
        'Target="styles.xml"/>'
        "</Relationships>"
    )
    root_rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="xl/workbook.xml"/>'
        '<Relationship Id="rId2" '
        'Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" '
        'Target="docProps/core.xml"/>'
        '<Relationship Id="rId3" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" '
        'Target="docProps/app.xml"/>'
        "</Relationships>"
    )
    content_types_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/styles.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        '<Override PartName="/docProps/core.xml" '
        'ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        '<Override PartName="/docProps/app.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
        "</Types>"
    )
    styles_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="2"><fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="gray125"/></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        "</styleSheet>"
    )
    core_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" '
        'xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:dcmitype="http://purl.org/dc/dcmitype/" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        '<dc:creator>Codex</dc:creator>'
        '<cp:lastModifiedBy>Codex</cp:lastModifiedBy>'
        "</cp:coreProperties>"
    )
    app_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
        'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
        '<Application>Codex</Application>'
        "</Properties>"
    )

    with zipfile.ZipFile(template_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types_xml)
        zf.writestr("_rels/.rels", root_rels_xml)
        zf.writestr("docProps/core.xml", core_xml)
        zf.writestr("docProps/app.xml", app_xml)
        zf.writestr("xl/workbook.xml", workbook_xml)
        zf.writestr("xl/_rels/workbook.xml.rels", workbook_rels_xml)
        zf.writestr("xl/styles.xml", styles_xml)
        zf.writestr("xl/worksheets/sheet1.xml", sheet_xml)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="读取 Excel 模版并调用 eagleyun_create_rule.js 导入规则。"
    )
    parser.add_argument("--excel", help="指定 Excel 模版文件路径（.xlsx/.xlsm）。")
    parser.add_argument(
        "--template-dir",
        default=str(DEFAULT_TEMPLATE_DIR),
        help=f"未指定 --excel 时，默认从该目录中查找模板文件，默认值: {DEFAULT_TEMPLATE_DIR}",
    )
    parser.add_argument("--sheet", help="指定工作表名称，默认优先选择 Rules/规则。")
    parser.add_argument(
        "--output-json",
        default=str(DEFAULT_OUTPUT_JSON),
        help=f"Excel 转换后的 JSON 输出路径，默认值: {DEFAULT_OUTPUT_JSON}",
    )
    parser.add_argument(
        "--engine",
        choices=("auto", "api", "browser"),
        default="browser",
        help="导入引擎，默认 browser：匹配值按 Excel 原样读取，并在页面中直接搜索/选择；auto 会先走 API 再回退浏览器。",
    )
    parser.add_argument(
        "--only-generate-json",
        action="store_true",
        help="只把 Excel 转成 JSON，不调用导入接口脚本。",
    )
    parser.add_argument(
        "--init-template",
        action="store_true",
        help="在模板目录生成示例 Excel 模版后退出。",
    )
    return parser


def sanitize_passthrough_args(args: Sequence[str]) -> List[str]:
    sanitized: List[str] = []
    skip_next = False
    for index, arg in enumerate(args):
        if skip_next:
            skip_next = False
            continue
        if arg == "--config":
            raise ValueError("请不要在 Excel 导入脚本后额外传入 --config，脚本会自动生成并使用 JSON 配置。")
        if arg.startswith("--config="):
            raise ValueError("请不要在 Excel 导入脚本后额外传入 --config，脚本会自动生成并使用 JSON 配置。")
        sanitized.append(arg)
        if arg in {"--base-url", "--username", "--password", "--account-master", "--corp-code", "--redirect", "--target-path", "--dlp-prefix", "--output-dir", "--session-dir", "--csrf-token"}:
            if index + 1 >= len(args):
                raise ValueError(f"参数 {arg} 缺少取值。")
            skip_next = True
            sanitized.append(args[index + 1])
    return sanitized


def strip_flag_args(args: Sequence[str], flags: Sequence[str]) -> List[str]:
    ignored = set(flags)
    return [arg for arg in args if arg not in ignored]


def is_dry_run_mode(args: Sequence[str]) -> bool:
    return "--apply" not in args


def sanitize_path_name(value: str) -> str:
    text = re.sub(r"[^\w\-.]+", "-", value.strip(), flags=re.UNICODE).strip("-")
    return text or "rule"


def print_completed_output(completed: subprocess.CompletedProcess[str]) -> None:
    if completed.stdout:
        print(completed.stdout, end="" if completed.stdout.endswith("\n") else "\n")
    if completed.stderr:
        print(completed.stderr, end="" if completed.stderr.endswith("\n") else "\n", file=sys.stderr)


def run_api_import(node_script: Path, output_json: Path, passthrough: Sequence[str]) -> subprocess.CompletedProcess[str]:
    command = ["node", str(node_script), "--config", str(output_json), *passthrough]
    print(f"开始调用 API 导入脚本: {' '.join(command)}")
    completed = subprocess.run(
        command,
        cwd=os.getcwd(),
        text=True,
        capture_output=True,
    )
    print_completed_output(completed)
    return completed


def run_browser_batch(
    browser_script: Path,
    rules: Sequence[Dict[str, object]],
    *,
    dry_run: bool,
    output_root: Path,
) -> int:
    output_root.mkdir(parents=True, exist_ok=True)
    rules_dir = output_root / "rules"
    profiles_dir = output_root / "profiles"
    rules_dir.mkdir(parents=True, exist_ok=True)
    profiles_dir.mkdir(parents=True, exist_ok=True)

    base_debug_port = int(os.environ.get("CHROME_DEBUG_PORT_BASE", "9555"))
    results = []

    for index, rule in enumerate(rules, start=1):
        safe_name = sanitize_path_name(stringify(rule.get("name")) or f"rule-{index:03d}")
        rule_json_path = rules_dir / f"{index:03d}-{safe_name}.json"
        browser_output_dir = output_root / f"{index:03d}-{safe_name}"
        profile_dir = profiles_dir / f"{index:03d}-{safe_name}"
        match_value = extract_match_value(rule)

        write_json(rule_json_path, rule)

        env = os.environ.copy()
        env.setdefault("EAGLEYUN_HEADLESS", "1")
        env["RULE_CONFIG_FILE"] = str(rule_json_path)
        env["OUTPUT_DIR"] = str(browser_output_dir)
        env["CHROME_PROFILE_DIR"] = str(profile_dir)
        env["CHROME_DEBUG_PORT"] = str(base_debug_port + index - 1)
        env["DRY_RUN"] = "1" if dry_run else "0"

        command = ["node", str(browser_script)]
        print(
            f"开始调用浏览器导入脚本 [{index}/{len(rules)}]: "
            f"{rule.get('name')} (匹配值: {match_value or '-'})"
        )
        completed = subprocess.run(
            command,
            cwd=os.getcwd(),
            env=env,
            text=True,
            capture_output=True,
        )
        print_completed_output(completed)

        results.append(
            {
                "index": index - 1,
                "name": rule.get("name"),
                "ok": completed.returncode == 0,
                "returncode": completed.returncode,
                "outputDir": str(browser_output_dir),
            }
        )

        if completed.returncode != 0:
            write_json(output_root / "browser-batch-results.json", results)
            return completed.returncode

    write_json(output_root / "browser-batch-results.json", results)
    print(f"浏览器批量结果: {output_root / 'browser-batch-results.json'}")
    return 0


def main() -> int:
    parser = build_arg_parser()
    args, passthrough = parser.parse_known_args()
    passthrough = sanitize_passthrough_args(passthrough)

    template_dir = Path(args.template_dir).expanduser().resolve()
    output_json = Path(args.output_json).expanduser().resolve()

    if args.init_template:
        if args.excel:
            template_path = Path(args.excel).expanduser().resolve()
        else:
            template_path = template_dir / DEFAULT_TEMPLATE_NAME
        create_template_excel(template_path)
        print(f"已生成 Excel 模版: {template_path}")
        return 0

    excel_path = resolve_excel_path(args.excel, template_dir)
    active_sheet_name, table_rows = load_table_from_excel(excel_path, args.sheet)
    rules = [row_to_rule(row, row_number) for row_number, row in table_rows]

    payload = {
        "meta": {
            "excelPath": str(excel_path),
            "sheetName": active_sheet_name,
            "rowCount": len(rules),
        },
        "rules": rules,
    }
    write_json(output_json, payload)

    print(f"已读取 Excel 模版: {excel_path}")
    print(f"工作表: {active_sheet_name}")
    print(f"规则数量: {len(rules)}")
    print(f"生成 JSON: {output_json}")

    if args.only_generate_json:
        return 0

    node_script = SCRIPT_DIR / "eagleyun_create_rule.js"
    if not node_script.exists():
        raise FileNotFoundError(f"未找到导入脚本: {node_script}")
    browser_script = SCRIPT_DIR / "eagleyun_create_rule_browser.js"
    if not browser_script.exists():
        raise FileNotFoundError(f"未找到浏览器导入脚本: {browser_script}")

    if args.engine == "browser":
        dry_run = is_dry_run_mode(passthrough)
        return run_browser_batch(
            browser_script,
            rules,
            dry_run=dry_run,
            output_root=(output_json.parent / DEFAULT_BROWSER_BATCH_DIR.name).resolve(),
        )

    api_completed = run_api_import(node_script, output_json, passthrough)
    if api_completed.returncode == 0 or args.engine == "api":
        return api_completed.returncode

    combined_output = f"{api_completed.stdout}\n{api_completed.stderr}"
    if "Unable to find sensitive tag" not in combined_output:
        return api_completed.returncode

    print("API 模式未能解析敏感标签，自动回退到浏览器模式继续执行。")
    dry_run = is_dry_run_mode(passthrough)
    return run_browser_batch(
        browser_script,
        rules,
        dry_run=dry_run,
        output_root=(output_json.parent / DEFAULT_BROWSER_BATCH_DIR.name).resolve(),
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
