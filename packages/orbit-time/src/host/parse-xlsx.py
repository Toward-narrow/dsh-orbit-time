#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Orbit Time Excel reader.

Reads one workbook with openpyxl, detects the header row, maps Chinese/English
column names onto a stable field set, and emits JSON on stdout.

Contract
--------
argv[1] : absolute path of the workbook
argv[2] : JSON options (optional). Recognised keys:
            sheet        - sheet title or 0-based index (default: best-scoring sheet)
            headerRow    - 1-based row holding headers, or null to auto-detect
            mapping      - { field: headerText } overrides / additions
            wantAll      - true to return every sheet's metadata
            previewRows  - how many rows to include in `preview` (default 12)
            subject      - label for matrix entries ("早打卡值班")
            note         - what the duty is, for matrix entries. Roster sheets
                           usually spell this out above the grid; when this is
                           absent the sheet's own annotation text is used
            timeRules    - [{ match: ["晚自习"], start: "19:30", end: "20:50" }]
                           first rule whose keyword appears in the sheet name, the
                           file name, or the text above the matrix supplies the time
            weekOneMonday - ISO date of Monday in "第1周", for week-block rosters
            region       - "A1:K9" to read an explicit block of a sheet

Two roster layouts are understood, chosen automatically:

  records  one row per session, with date / time / name columns
           | 日期 | 开始时间 | 事项 | 姓名 |
           | 3-02 | 09:00    | 高数 | 张三 |

  matrix   a calendar grid: the day headers are dates ("2026-09-09") or weekdays
           grouped under "第N周". Every non-empty body cell names the person on
           duty for that column's day.
           | 2026-09-09 | 2026-09-16 | ...      | 第2周 |          |
           | 李四     | 周九       | ...      | 周一  | 周二 ... |
           | 王五     | 吴十     | ...      | 李四 | 王五   |
stdout  : one JSON object. On failure: {"ok": false, "error": "..."} and exit 0
          so the caller can report the reason without parsing stderr.

Output
------
{
  "ok": true,
  "file": "<path>", "mtimeMs": 123, "sheets": ["Sheet1", ...],
  "sheet": "Sheet1", "headerRow": 1, "rowCount": 42,
  "headers": [{"index": 0, "text": "日期", "field": "date", "confidence": "alias"}],
  "mapping": {"date": "日期", "start": "开始时间", ...},
  "unmapped": ["备注2"],
  "rows": [ { "_row": 3, "date": "2026-03-02", "start": "09:00", ..., "_warnings": [] } ],
  "preview": [ {...}, ... ],
  "sheetNotes": ["考勤负责人注意事项：...", "点名时间：19:30 20:50"],
  "warnings": ["..."]
}

`sheetNotes` is the sheet's own prose — the annotation cells a roster uses to
say *what the duty is* ("点名时间：19：30 20：50", "①一人负责两个班的晚自习考勤").
It sits outside the grid, so it is collected separately from the records and
reported to the analyzer and (for matrix rosters) as each entry's note.
"""

import datetime as _dt
import json
import re
import sys

# The host reads this process's stdout. Python picks the ANSI code page for a
# piped stdout on Windows, which cannot encode the Chinese column names and
# titles that appear in every diagnostic string, so pin the wire to UTF-8.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

FIELD_ALIASES = {
    "date": ["日期", "date", "day", "日程日期", "会议日期", "上课日期", "安排日期", "值班日期", "工作日期"],
    "weekday": ["星期", "周几", "礼拜", "weekday", "week", "dayofweek"],
    "start": ["开始时间", "起始时间", "开始", "start", "starttime", "start_time", "from", "时间", "time", "时段", "上课时间", "会议时间", "预约时间"],
    "end": ["结束时间", "截止时间", "结束", "end", "endtime", "end_time", "to", "下课时间", "散会时间"],
    "title": ["事项", "标题", "主题", "内容", "任务", "名称", "工作内容", "会议主题", "会议名称", "活动名称", "项目", "title", "subject", "topic", "event", "task", "agenda", "summary"],
    "person": ["姓名", "参与人", "参会人", "与会人", "负责人", "执行人", "人员", "成员", "名字", "人", "name", "owner", "assignee", "attendee", "participant", "staff", "poc"],
    "location": ["地点", "位置", "会议室", "教室", "场地", "location", "room", "place", "venue", "site"],
    "classroom": ["班级", "class", "grade"],
    "course": ["课程", "课程名称", "科目", "course", "subjectname"],
    "teacher": ["授课教师", "教师", "老师", "讲师", "teacher", "instructor", "lecturer", "host"],
    "duration": ["时长", "持续时间", "duration", "hours", "小时"],
    "category": ["类型", "类别", "分类", "种类", "type", "category", "kind", "tag"],
    "status": ["状态", "status", "state"],
    "priority": ["优先级", "重要程度", "priority", "importance"],
    "notes": ["备注", "说明", "描述", "详情", "note", "notes", "remark", "remarks", "comment", "description", "detail", "details"],
    "link": ["链接", "会议链接", "网址", "link", "url", "meetingurl", "meeting_url"],
    "contact": ["联系方式", "电话", "手机", "contact", "phone", "tel", "mobile", "email", "邮箱"],
}

# Fields whose values are treated as "the row belongs to this person".
PERSON_FIELDS = ("person",)

_WEEKDAY_HINT = re.compile(r"^(星期|周|礼拜|week)", re.I)
_TIME_ONLY = re.compile(r"^\s*(\d{1,2})\s*[:：.时点]\s*(\d{1,2})?\s*(?:分)?\s*(上午|下午|晚上|中午|凌晨|am|pm)?\s*$", re.I)
_PERIOD = re.compile(r"^\s*(上午|下午|晚上|中午|凌晨|早上|傍晚|am|pm)\s*", re.I)
_DURATION = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(小时|h|hour|hours|分钟|min|mins|minute|minutes)?\s*$", re.I)
_DATE_CLEAN = re.compile(r"[年月]")
_RANGE_SPLIT = re.compile(r"\s*(?:-|–|—|~|～|至|到|to)\s*", re.I)
_FULL_DATE = re.compile(r"\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}")
_WEEK_BLOCK = re.compile(r"^第\s*([0-9一二三四五六七八九十百]+)\s*周")
_WEEKDAY = re.compile(r"^周\s*([一二三四五六日天])$")
_CN_DIGITS = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
_WEEKDAY_INDEX = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}


def norm(value):
    """Normalise free text for alias matching."""
    if value is None:
        return ""
    text = str(value).strip()
    text = text.replace("\u3000", " ").replace("\n", " ")
    text = re.sub(r"\s+", " ", text)
    return text


def norm_key(value):
    """Aggressive key used only for alias comparison."""
    text = norm(value).lower()
    text = re.sub(r"[\s_\-()（）\[\]【】:：*※.]", "", text)
    return text


def cell_text(value):
    if value is None:
        return ""
    if isinstance(value, _dt.datetime):
        return value.strftime("%Y-%m-%d %H:%M")
    if isinstance(value, _dt.date):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, _dt.time):
        return value.strftime("%H:%M")
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return norm(value)


def parse_date(value):
    """Return (iso_date, warning). Accepts datetimes, "2026-03-02", "3月2日", "2026/3/2"."""
    if value is None or (isinstance(value, str) and value.strip() == ""):
        return None, None
    if isinstance(value, _dt.datetime):
        return value.date().isoformat(), None
    if isinstance(value, _dt.date):
        return value.isoformat(), None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        # Excel serial date (1900 date system, with its leap-year bug).
        serial = float(value)
        if 20000 <= serial <= 60000:
            base = _dt.date(1899, 12, 30)
            try:
                return (base + _dt.timedelta(days=serial)).isoformat(), None
            except OverflowError:
                return None, "无法解析的日期序列值 %r" % (value,)
        return None, "无法解析的日期 %r" % (value,)

    text = norm(value)
    if text == "":
        return None, None
    cleaned = _DATE_CLEAN.sub("-", text)
    cleaned = cleaned.replace("日", "").replace("/", "-").replace(".", "-")
    cleaned = re.sub(r"\s+", "", cleaned)
    match = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", cleaned)
    if match:
        year, month, day = (int(part) for part in match.groups())
        try:
            return _dt.date(year, month, day).isoformat(), None
        except ValueError:
            return None, "非法日期 %r" % (text,)
    match = re.match(r"^(\d{1,2})-(\d{1,2})$", cleaned)
    if match:
        month, day = (int(part) for part in match.groups())
        year = _dt.date.today().year
        try:
            return _dt.date(year, month, day).isoformat(), None
        except ValueError:
            return None, "非法日期 %r" % (text,)
    match = re.match(r"^(\d{1,2})-(\d{1,2})-(\d{1,2})$", cleaned)
    if match:
        # Ambiguous 3-part form; assume Y-M-D when the first part looks like a year.
        first, second, third = (int(part) for part in match.groups())
        if first > 31:
            try:
                return _dt.date(first, second, third).isoformat(), None
            except ValueError:
                return None, "非法日期 %r" % (text,)
    match = re.search(r"(\d{4})-(\d{1,2})-(\d{1,2})", cleaned)
    if match:
        year, month, day = (int(part) for part in match.groups())
        try:
            return _dt.date(year, month, day).isoformat(), None
        except ValueError:
            return None, "非法日期 %r" % (text,)
    return None, "无法解析的日期 %r" % (text,)


def parse_time(value):
    """Return ("HH:MM", warning). Accepts times, datetimes, "9:00", "9点", "14:00-15:00"."""
    if value is None or (isinstance(value, str) and value.strip() == ""):
        return None, None
    if isinstance(value, _dt.datetime):
        return value.strftime("%H:%M"), None
    if isinstance(value, _dt.time):
        return value.strftime("%H:%M"), None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        serial = float(value)
        if 0 <= serial < 1:
            minutes = int(round(serial * 24 * 60)) % (24 * 60)
            return "%02d:%02d" % (minutes // 60, minutes % 60), None
        if 1 <= serial < 24:
            # Bare hour number, e.g. 9 -> 09:00, 14 -> 14:00.
            hour = int(serial)
            minutes = int(round((serial - hour) * 60))
            return "%02d:%02d" % (hour % 24, minutes), None
        return None, "无法解析的时间 %r" % (value,)

    text = norm(value)
    if text == "":
        return None, None
    period = None
    period_match = _PERIOD.match(text)
    if period_match:
        period = period_match.group(1).lower()
        text = text[period_match.end():]
    text = re.sub(r"\s+", "", text)
    # A range in a single cell: keep the first endpoint.
    if _RANGE_SPLIT.search(text):
        text = _RANGE_SPLIT.split(text)[0]
    match = re.match(r"^(\d{1,2})[:：.时点](\d{1,2})分?$", text)
    if match:
        hour, minute = int(match.group(1)), int(match.group(2))
    else:
        match = re.match(r"^(\d{1,2})[:：.时点]?$", text)
        if not match:
            return None, "无法解析的时间 %r" % (norm(value),)
        hour, minute = int(match.group(1)), 0
    if period in ("下午", "晚上", "傍晚", "pm") and hour < 12:
        hour += 12
    if period in ("中午",) and hour < 11:
        hour += 12
    if period in ("凌晨",) and hour == 12:
        hour = 0
    if not (0 <= hour <= 24 and 0 <= minute < 60):
        return None, "非法时间 %r" % (norm(value),)
    if hour == 24:
        hour = 0
    return "%02d:%02d" % (hour, minute), None


def parse_duration_minutes(value):
    if value is None or value == "":
        return None, None
    if isinstance(value, _dt.time):
        return value.hour * 60 + value.minute, None
    if isinstance(value, _dt.datetime):
        return value.hour * 60 + value.minute, None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = float(value)
        if 0 < number <= 1:
            return int(round(number * 24 * 60)), None
        return int(round(number)), None
    text = norm(value)
    match = _DURATION.match(text)
    if not match:
        return None, "无法解析的时长 %r" % (text,)
    number = float(match.group(1))
    unit = (match.group(2) or "").lower()
    if unit in ("小时", "h", "hour", "hours", ""):
        return int(round(number * 60)), None
    return int(round(number)), None


# --------------------------------------------------------------------- matrix
#
# A duty roster is usually a calendar grid rather than a row-per-session table:
# the days run across the top (as real dates, or as 周一…周四 grouped under 第N周)
# and each body cell names whoever is on duty for that column's day. Reading it
# means transposing cells into records, not reading rows.


def column_index(reference):
    """Excel column letters to a 0-based index: 'A' -> 0, 'AB' -> 27."""
    total = 0
    for char in reference.upper():
        if not ("A" <= char <= "Z"):
            continue
        total = total * 26 + (ord(char) - ord("A") + 1)
    return total - 1


def parse_region(spec):
    """'B3:M9' -> (min_row, min_col, max_row, max_col), all 1-based."""
    match = re.match(r"^\s*([A-Za-z]+)(\d+)\s*:\s*([A-Za-z]+)(\d+)\s*$", spec or "")
    if not match:
        return None
    left, top, right, bottom = match.groups()
    first_col, last_col = column_index(left), column_index(right)
    first_row, last_row = int(top), int(bottom)
    return (
        min(first_row, last_row),
        min(first_col, last_col),
        max(first_row, last_row),
        max(first_col, last_col),
    )


def cn_number(text):
    """'2', '二', '12', '十六' -> int, or None."""
    if text is None:
        return None
    cleaned = str(text).strip()
    if cleaned.isdigit():
        return int(cleaned)
    if cleaned == "十":
        return 10
    if cleaned.startswith("十") and len(cleaned) == 2 and cleaned[1] in _CN_DIGITS:
        return 10 + _CN_DIGITS[cleaned[1]]
    if cleaned.endswith("十") and len(cleaned) == 2 and cleaned[0] in _CN_DIGITS:
        return _CN_DIGITS[cleaned[0]] * 10
    if len(cleaned) == 3 and cleaned[1] == "十" and cleaned[0] in _CN_DIGITS and cleaned[2] in _CN_DIGITS:
        return _CN_DIGITS[cleaned[0]] * 10 + _CN_DIGITS[cleaned[2]]
    if len(cleaned) == 1 and cleaned in _CN_DIGITS:
        return _CN_DIGITS[cleaned]
    return None


def date_header_kind(cell):
    """Classify a header cell: a real date, a 第N周 block, a weekday, or nothing."""
    if isinstance(cell, _dt.datetime):
        return ("date", cell.date())
    if isinstance(cell, _dt.date):
        return ("date", cell)
    if isinstance(cell, (int, float)) and not isinstance(cell, bool):
        if 20000 <= float(cell) <= 60000:
            iso, _ = parse_date(cell)
            if iso:
                return ("date", _dt.date.fromisoformat(iso))
        return (None, None)
    text = norm(cell)
    if text == "":
        return (None, None)
    if _FULL_DATE.search(text):
        iso, _ = parse_date(text)
        if iso:
            return ("date", _dt.date.fromisoformat(iso))
    match = _WEEK_BLOCK.match(text)
    if match:
        number = cn_number(match.group(1))
        if number:
            return ("week", number)
    match = _WEEKDAY.match(text)
    if match and match.group(1) in _WEEKDAY_INDEX:
        return ("weekday", _WEEKDAY_INDEX[match.group(1)])
    return (None, None)


def merged_spans(ws):
    """Every merged range as (min_col, max_col, min_row, max_row), 1-based.

    A merged header cell is the only reliable record of how many duty slots a
    weekday or date covers: the covered cells are empty whether or not they were
    merged, and the names underneath can sit in any of the slots, so nothing in
    the values themselves says how wide the label was.
    """
    spans = []
    for merged in ws.merged_cells.ranges:
        min_col, min_row, max_col, max_row = merged.min_col, merged.min_row, merged.max_col, merged.max_row
        spans.append((min_col, max_col, min_row, max_row))
    return spans


def span_width(spans, row, col):
    """How many columns the merged cell starting at (row, col) covers; else 1."""
    for min_col, max_col, min_row, max_row in spans:
        if min_row <= row <= max_row and min_col <= col <= max_col:
            return max_col - min_col + 1
    return 1


def detect_matrix(rows, region=None, merges=None):
    """Choose the header layout, or None when the sheet is a plain record table."""
    if region is not None:
        min_row, min_col, max_row, max_col = region
    else:
        min_row, min_col, max_row, max_col = 1, 1, len(rows), max((len(row) for row in rows), default=0)

    best_date = (0, None)
    for row_index in range(min_row, min(max_row, min_row + 30) + 1):
        row = rows[row_index - 1] if row_index - 1 < len(rows) else ()
        count = 0
        starts = []
        for col_index in range(min_col, max_col + 1):
            value = row[col_index - 1] if col_index - 1 < len(row) else None
            kind, payload = date_header_kind(value)
            if kind == "date":
                count += 1
                starts.append(col_index)
            elif count > 0:
                break
        if count >= 2 and count > best_date[0]:
            best_date = (count, (row_index, starts))

    if best_date[1] is not None:
        row_index, starts = best_date[1]
        row = rows[row_index - 1]
        dates = []
        for col_index in starts:
            value = row[col_index - 1] if col_index - 1 < len(row) else None
            _, payload = date_header_kind(value)
            dates.append((col_index, payload))
        body = list(range(row_index + 1, max_row + 1))
        # Same rule as the week blocks: a date header is often merged across
        # several duty slots, and only its first cell holds the date. The merge
        # range states the width; without it, a date owns the columns up to the
        # next date, which is what an unmerged header row means.
        date_cols = [col for col, _ in dates]
        spans = []
        for position, (col_index, day) in enumerate(dates):
            width = span_width(merges or [], row_index, col_index)
            if merges is None or width <= 1:
                limit = date_cols[position + 1] - 1 if position + 1 < len(date_cols) else col_index
                end_col = max(col_index, limit)
            else:
                end_col = col_index + width - 1
            spans.append((col_index, end_col, day))
        return {"mode": "matrixDate", "headerRow": row_index, "columns": dates, "columnSpans": spans, "bodyRows": body}

    # Week-block layout: a 第N周 row, then a weekday row, then duty rows.
    blocks = []
    for row_index in range(min_row, max_row + 1):
        row = rows[row_index - 1] if row_index - 1 < len(rows) else ()
        cells = [norm(value) for value in row]
        week_number = None
        for value in cells:
            match = _WEEK_BLOCK.match(value) if value else None
            if match:
                week_number = cn_number(match.group(1))
                break
        if week_number is None:
            continue
        # The weekday row is the next row that names at least two weekdays.
        weekday_row = None
        for candidate in range(row_index + 1, min(row_index + 4, max_row) + 1):
            candidate_cells = rows[candidate - 1] if candidate - 1 < len(rows) else ()
            hits = [date_header_kind(value) for value in candidate_cells]
            weekday_hits = [(index + 1, payload) for index, (kind, payload) in enumerate(hits) if kind == "weekday"]
            if len(weekday_hits) >= 2:
                weekday_row = (candidate, weekday_hits)
                break
        if weekday_row is None:
            continue
        # Duty rows run until the next block marker or a blank gap.
        duty_rows = []
        for candidate in range(weekday_row[0] + 1, max_row + 1):
            candidate_cells = [norm(value) for value in (rows[candidate - 1] if candidate - 1 < len(rows) else ())]
            if any(_WEEK_BLOCK.match(value) for value in candidate_cells if value):
                break
            if all(value == "" for value in candidate_cells):
                break
            duty_rows.append(candidate)
        # How many columns each weekday owns.
        #
        # A weekday header is usually a merged cell — "周一" over the two duty
        # slots underneath it — and only its top-left cell carries the text. The
        # merge range is what states the width; nothing in the values does, and
        # guessing from where names happen to sit loses a slot whenever the
        # second slot is the empty one. Without merge information, fall back to
        # the columns up to the next weekday, which is what an unmerged header
        # row means anyway.
        weekday_cols = [col for col, _ in weekday_row[1]]
        spans = []
        for position, (start_col, weekday_index) in enumerate(weekday_row[1]):
            width = span_width(merges or [], weekday_row[0], start_col)
            if merges is None or width <= 1:
                limit = weekday_cols[position + 1] - 1 if position + 1 < len(weekday_cols) else start_col
                end_col = max(start_col, limit)
            else:
                end_col = start_col + width - 1
            spans.append((start_col, end_col, weekday_index))
        blocks.append(
            {
                "week": week_number,
                "labelRow": row_index,
                "weekdayRow": weekday_row[0],
                "weekdays": weekday_row[1],
                "weekdaySpans": spans,
                "dutyRows": duty_rows,
            }
        )

    if blocks:
        return {"mode": "matrixWeek", "blocks": blocks, "bodyRows": []}
    return None


def shift_by_weekday(monday, weekday_index):
    return monday + _dt.timedelta(days=weekday_index)



def split_datetime_cell(text):
    """Split "2026-03-02 09:00" into its date and time halves."""
    match = re.match(r"^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})[ T]+(\d{1,2}[:：.]\d{1,2})", text)
    if match:
        return match.group(1), match.group(2)
    return None, None


def score_header_row(row):
    """Count alias matches, weighting the fields a schedule always has."""
    score = 0
    hits = set()
    for cell in row:
        key = norm_key(cell)
        if key == "":
            continue
        for field, aliases in FIELD_ALIASES.items():
            if key in {norm_key(alias) for alias in aliases}:
                hits.add(field)
                score += 3 if field in ("date", "start", "title", "person") else 1
                break
    return score, hits


def build_alias_index(extra_mapping):
    """aliasKey -> field, including caller-supplied overrides."""
    index = {}
    for field, aliases in FIELD_ALIASES.items():
        for alias in aliases:
            index.setdefault(norm_key(alias), field)
    for field, header in (extra_mapping or {}).items():
        if isinstance(header, str) and header.strip():
            index[norm_key(header)] = field
    return index


def detect_header(ws, max_scan=30):
    best = (0, 1, set())
    for row_index, row in enumerate(ws.iter_rows(min_row=1, max_row=max_scan, values_only=True), start=1):
        score, hits = score_header_row(row)
        if score > best[0]:
            best = (score, row_index, hits)
    return best


def sheet_score(ws):
    score, row_index, hits = detect_header(ws)
    coverage = len(hits)
    return score + coverage * 2, row_index


def resolve_time_rules(options, sheet_name, file_name, notes=None):
    """Pick the first time rule whose keyword appears in the sheet, file, or its prose.

    The text above a roster is where a duty states its own clock ("点名时间：19：30"),
    so it is part of the haystack: with several rosters sharing one set of rules,
    the sheet's own wording is what keeps the right window on the right file.
    """
    rules = options.get("timeRules")
    if not isinstance(rules, list):
        return None
    haystack = str(sheet_name) + " " + str(file_name)
    if notes:
        haystack += " " + " ".join(str(line) for line in notes)
    needle_source = haystack.lower()
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        keys = rule.get("match")
        if isinstance(keys, str):
            keys = [keys]
        if not isinstance(keys, list):
            continue
        for key in keys:
            if str(key).lower() in needle_source:
                start, _ = parse_time(rule.get("start"))
                end, _ = parse_time(rule.get("end"))
                return {"start": start or "", "end": end or "", "sheet": start or "", "match": str(key)}
    return None


def _minutes_of_clock(text):
    """Minutes past midnight for a clock reading ("19:30" -> 1170), or None."""
    match = re.match(r"^\s*(\d{1,2})\s*[:：.]\s*(\d{1,2})", text)
    if not match:
        return None
    hour, minute = int(match.group(1)), int(match.group(2))
    if hour > 23 or minute > 59:
        return None
    return hour * 60 + minute


def roster_time_notes(notes):
    """Clock readings a sheet states about itself in prose ("点名时间：19：30 20：50")."""
    found = []
    for line in notes or []:
        if not isinstance(line, str):
            continue
        for clock in re.findall(r"\d{1,2}\s*[:：.]\s*\d{1,2}", line):
            minutes = _minutes_of_clock(clock)
            if minutes is not None:
                found.append(minutes)
    return found


def audit_roster_time(time_rule, notes):
    """Complain when the sheet's own wording and the chosen time window disagree.

    Roster sheets carry no time column, so the window comes from a keyword rule.
    Two ways that goes wrong, and both are invisible otherwise — the name filter
    and the date scan are perfectly happy either way:

      * no rule matches at all, while the sheet states its own clock
        ("点名时间：19：30 20：50"), so the entries end up with no time; and
      * a rule meant for the *other* roster wins, producing a title and a clock
        that contradict each other — a "早打卡值班" duty scheduled at 19:30.
    """
    stated = roster_time_notes(notes)
    if not stated:
        return None
    stamped = "、".join("%02d:%02d" % (value // 60, value % 60) for value in stated[:4])
    if time_rule is None:
        return "表里写明的时间是 %s，但没有时间规则匹配到这份表，条目会没有上下班时间。" % stamped
    start, _ = parse_time(time_rule.get("start"))
    end, _ = parse_time(time_rule.get("end"))
    start_minutes = _minutes_of_clock(start) if start else None
    if start_minutes is None:
        return None

    def close(a, b):
        return abs(a - b) <= 10

    end_minutes = _minutes_of_clock(end) if end else None
    # Any reading the rule matches means the window was taken from this sheet.
    if any(close(start_minutes, value) for value in stated):
        return None
    if end_minutes is not None and any(close(end_minutes, value) for value in stated):
        return None
    return "表里写明的时间是 %s，但这份表被配成了 %s–%s（关键词 %r）——主题和时间可能对不上。" % (
        stamped,
        start,
        end or "?",
        time_rule.get("match"),
    )


def read_grid(ws, region):
    """Materialise a sheet (or a sub-region) as a rectangular list of rows."""
    if region is not None:
        min_row, min_col, max_row, max_col = region
    else:
        min_row, min_col = 1, 1
        max_row = max(ws.max_row or 1, 1)
        max_col = max(ws.max_column or 1, 1)
    grid = []
    for row in ws.iter_rows(min_row=min_row, max_row=max_row, min_col=min_col, max_col=max_col, values_only=True):
        grid.append(list(row))
    return grid, (min_row, min_col, max_row, max_col)


def sheet_notes(ws, layout):
    """The sheet's own annotation text: everything outside the duty grid.

    A roster states what the duty *is* in prose next to the table — "点名时间：
    19：30 20：50", "①一人负责两个班的晚自习考勤", "教室：3班：A101". Those
    cells sit beyond the grid, so they are dropped by every value-based scan yet
    they are the only place the sheet says more than a name and a date. Read them
    before the table: the rows above the header block and the columns after it.

    Week markers and weekday labels are structure, not prose, so they are
    filtered out.
    """
    spans = merged_spans(ws)
    lines = []

    def add(value):
        # One annotation cell often holds a whole numbered list; keep its lines
        # apart so a reader (and a note) is not handed one wall of text.
        for piece in cell_text(value).split("\n"):
            text = piece.strip()
            if text == "":
                continue
            if _WEEK_BLOCK.match(text) or _WEEKDAY.match(text) or _WEEKDAY_HINT.match(text):
                continue
            if any(text.startswith(kept) for kept in lines):
                continue
            lines.append(text)

    if layout["mode"] == "matrixDate":
        first_row = layout["headerRow"]
        last_col = 0
        for start_col, end_col, _ in layout.get("columnSpans") or [(col, col, day) for col, day in layout["columns"]]:
            last_col = max(last_col, end_col)
    else:
        first_block = (layout.get("blocks") or [{}])[0]
        first_row = first_block.get("labelRow", 1)
        last_col = 0
        for start_col, end_col, _ in first_block.get("weekdaySpans") or []:
            last_col = max(last_col, end_col)

    max_row = max(ws.max_row or 1, 1)
    max_col = max(ws.max_column or 1, 1)
    # Above the table: the header block's own rows. Left of it: nothing, so only
    # the columns to the right of the grid are scanned there.
    for row_index in range(1, min(first_row, max_row) + 1):
        for col_index in range(1, max_col + 1):
            if row_index >= first_row and col_index <= last_col:
                continue
            add(ws.cell(row=row_index, column=col_index).value)

    # Merged annotation blocks below the header (a tall "注意事项" cell) only
    # carry their text in the top-left cell.
    for min_col, max_col_, min_row, max_row_ in spans:
        if min_col <= last_col or min_row < 1 or min_row > min(first_row, max_row):
            continue
        add(ws.cell(row=min_row, column=min_col).value)
    return lines


def matrix_records(layout, grid, offset_row, offset_col, time_rule, subject, week_one_monday, note=""):
    """Turn a matrix layout into record rows (the same shape `records` mode emits)."""
    records = []
    start_time = (time_rule or {}).get("start", "")
    end_time = (time_rule or {}).get("end", "")
    note_text = note if isinstance(note, str) else ""

    def cell(row_index, col_index):
        local_row = row_index - offset_row
        local_col = col_index - offset_col
        if local_row < 0 or local_row >= len(grid):
            return None
        row = grid[local_row]
        if local_col < 0 or local_col >= len(row):
            return None
        return row[local_col]

    def emit(person, date_iso, excel_row, excel_col, weekday_text):
        text = norm(person)
        if text == "":
            return
        # A cell can hold a note instead of a name ("正常出勤用绿色填充").
        if len(text) > 12 or any(char in text for char in "：:①②③④⑤⑥注"):
            return
        records.append(
            {
                "_row": excel_row,
                "_col": excel_col,
                "date": date_iso,
                "weekday": weekday_text,
                "start": start_time,
                "end": end_time,
                "title": subject,
                "person": text,
                "location": "",
                "classroom": "",
                "teacher": "",
                "course": "",
                "category": "值班",
                "status": "",
                "priority": "",
                "notes": note_text,
                "link": "",
                "contact": "",
                "durationMinutes": None,
                "extras": {},
                "_warnings": [],
            }
        )

    if layout["mode"] == "matrixDate":
        spans = layout.get("columnSpans")
        if not spans:
            spans = [(col, col, day) for col, day in layout["columns"]]
        for excel_row in layout["bodyRows"]:
            for start_col, end_col, day in spans:
                for excel_col in range(start_col, end_col + 1):
                    value = cell(excel_row, excel_col)
                    if value is None or norm(value) == "":
                        continue
                    weekday_text = "周" + "一二三四五六日"[day.weekday()]
                    emit(value, day.isoformat(), excel_row, excel_col, weekday_text)
        return records

    if layout["mode"] == "matrixWeek":
        anchor = week_one_monday
        for block in layout["blocks"]:
            week = block["week"]
            # Every column a weekday covers, so a merged "周三" header emits the
            # names in both of its slots instead of only the first.
            spans = block.get("weekdaySpans")
            if not spans:
                windows = [(col, col, index) for col, index in block["weekdays"]]
            else:
                windows = spans
            for excel_row in block["dutyRows"]:
                for start_col, end_col, weekday_index in windows:
                    for excel_col in range(start_col, end_col + 1):
                        value = cell(excel_row, excel_col)
                        if value is None or norm(value) == "":
                            continue
                        date_iso = ""
                        if anchor is not None:
                            target = anchor + _dt.timedelta(days=(week - 1) * 7 + weekday_index)
                            date_iso = target.isoformat()
                        weekday_text = "周" + "一二三四五六日"[weekday_index]
                        emit(value, date_iso, excel_row, excel_col, weekday_text)
        return records

    return records


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: parse-xlsx.py <workbook> [optionsJson]"}))
        return 0

    path = sys.argv[1]
    options = {}
    if len(sys.argv) > 2 and sys.argv[2].strip():
        try:
            options = json.loads(sys.argv[2])
        except ValueError as error:
            print(json.dumps({"ok": False, "error": "选项不是合法 JSON: %s" % error}))
            return 0

    try:
        import openpyxl
    except ImportError as error:
        print(json.dumps({"ok": False, "error": "缺少 openpyxl: %s" % error}))
        return 0

    try:
        workbook = openpyxl.load_workbook(path, data_only=True, read_only=False)
    except Exception as error:  # noqa: BLE001 - reported to the user verbatim
        print(json.dumps({"ok": False, "error": "打不开工作簿: %s" % error}, ensure_ascii=False))
        return 0

    sheet_names = list(workbook.sheetnames)
    warnings = []

    requested = options.get("sheet")
    if isinstance(requested, int):
        if not (0 <= requested < len(sheet_names)):
            print(json.dumps({"ok": False, "error": "工作表序号 %d 超出范围" % requested}, ensure_ascii=False))
            return 0
        ws = workbook[sheet_names[requested]]
    elif isinstance(requested, str) and requested.strip():
        if requested not in sheet_names:
            print(json.dumps({"ok": False, "error": "找不到工作表 %r" % requested}, ensure_ascii=False))
            return 0
        ws = workbook[requested]
    else:
        scored = []
        for name in sheet_names:
            try:
                score, header_row = sheet_score(workbook[name])
            except Exception:  # noqa: BLE001 - a broken sheet must not hide the others
                score, header_row = (0, 1)
            scored.append((score, name, header_row))
        scored.sort(reverse=True)
        best_score, best_name, _ = scored[0]
        ws = workbook[best_name]
        if best_score <= 0:
            warnings.append("没有识别到表头行，已按第一行作为表头解析。")
        if len(scored) > 1 and scored[1][0] > 0 and scored[1][0] == best_score:
            warnings.append("多张工作表的表头得分相同，已选用 %r。" % best_name)

    alias_index = build_alias_index(options.get("mapping"))

    # ---- matrix (roster grid) detection ------------------------------------
    # A roster workbook is a calendar grid, so record-column detection always
    # fails on it. The caller can force the region; otherwise every sheet is
    # scored for a matrix header and the best one wins.
    region = parse_region(options.get("region"))
    if region is None and options.get("region"):
        warnings.append("region 参数无法解析（应形如 B3:M20），已忽略。")

    layout = None
    if options.get("mode") != "records":
        layout = detect_matrix(read_grid(ws, region)[0], region, merged_spans(ws))

    if layout is None and region is None and not (isinstance(requested, str) and requested.strip()):
        # Sheet auto-selection scores record headers only, so it can land on an
        # empty sheet when the roster lives in a matrix. Rescan every sheet for a
        # matrix header and rebuild `warnings` from scratch, because the record
        # path's complaints no longer apply to the layout that won.
        best = None
        for name in sheet_names:
            candidate_grid, _ = read_grid(workbook[name], None)
            candidate = detect_matrix(candidate_grid, None, merged_spans(workbook[name]))
            if candidate is None:
                continue
            weight = len(candidate.get("columns", [])) if candidate["mode"] == "matrixDate" else len(candidate.get("blocks", [])) * 8
            if best is None or weight > best[0]:
                best = (weight, name, candidate)
        if best is not None:
            _, best_name, best_layout = best
            if best_name != ws.title:
                warnings = []
                ws = workbook[best_name]
            layout = best_layout

    if layout is not None:
        grid, offsets = read_grid(ws, region)
        offset_row, offset_col, _, _ = offsets
        notes = sheet_notes(ws, layout)
        time_rule = resolve_time_rules(options, ws.title, path, notes)
        if time_rule is None and not roster_time_notes(notes):
            warnings.append("未匹配到时间规则，矩阵条目没有上下班时间（可用 timeRules 指定）。")
        subject = norm(options.get("subject")) or (ws.title or "值班")
        # What the duty is. An explicit note is the operator's wording and wins;
        # otherwise the sheet's own prose is the only thing that says more than
        # "someone is on duty that day".
        note = norm(options.get("note"))
        if note == "" and notes:
            # Fold the annotation into one line and keep it scannable: the
            # timeline shows it under the title, and a wall of text there is
            # worse than the first sentence. `note` in the config overrides it.
            note = " · ".join(notes)
            if len(note) > 120:
                note = note[:119] + "…"
            warnings.append("条目说明取自表格上方的文字，可在配置里用 note 覆盖。")
        time_mismatch = audit_roster_time(time_rule, notes)
        if time_mismatch:
            warnings.append(time_mismatch)
        anchor = None
        anchor_text = options.get("weekOneMonday")
        if isinstance(anchor_text, str) and anchor_text.strip():
            anchor_iso, anchor_warning = parse_date(anchor_text)
            if anchor_iso:
                anchor = _dt.date.fromisoformat(anchor_iso)
            else:
                warnings.append("weekOneMonday 无法解析：%s" % anchor_warning)
        if layout["mode"] == "matrixWeek" and anchor is None:
            warnings.append("这是「第N周」式值班表，缺少 weekOneMonday，条目只有星期没有日期。")
        elif layout["mode"] == "matrixWeek":
            warnings.append("「第N周」已按 weekOneMonday=%s 换算为日期。" % anchor.isoformat())

        records = matrix_records(layout, grid, offset_row, offset_col, time_rule, subject, anchor, note)
        if layout["mode"] == "matrixDate":
            warnings.append(
                "识别为值班表网格：日期表头在第 %d 行，共 %d 列、%d 条记录。"
                % (layout["headerRow"], len(layout["columns"]), len(records))
            )
        else:
            warnings.append(
                "识别为「第N周」值班表：%d 个周块、%d 条记录。"
                % (len(layout["blocks"]), len(records))
            )
        if time_rule is not None:
            warnings.append("时间来自关键词 %r：%s–%s" % (time_rule.get("match"), time_rule.get("start") or "?", time_rule.get("end") or "?"))

        person_source = "值班单元格（姓名，按日期/星期定位）"
        warnings.append("姓名来源：%s" % person_source)
        preview_count = options.get("previewRows")
        if not isinstance(preview_count, int) or preview_count < 0:
            preview_count = 12
        records.sort(key=lambda row: (row["date"] or "9999", row["start"] or "99:99", row["_row"], row["_col"]))
        print(
            json.dumps(
                {
                    "ok": True,
                    "file": path,
                    "sheets": sheet_names,
                    "sheet": ws.title,
                    "layout": layout["mode"],
                    "headerRow": layout.get("headerRow", layout.get("blocks", [{}])[0].get("weekdayRow", 1)),
                    "rowCount": len(records),
                    "scannedRows": sum(
                        1 for row in grid for value in row if value is not None and norm(value) != ""
                    ),
                    "headers": [
                        {"index": index, "text": text, "field": None}
                        for index, text in enumerate(["值班日期", "星期", "开始时间", "结束时间", "事项", "姓名"])
                    ],
                    "mapping": {
                        "date": "值班日期",
                        "weekday": "星期",
                        "start": "开始时间",
                        "end": "结束时间",
                        "title": "事项",
                        "person": "姓名",
                    },
                    "unmapped": [],
                    "rows": records,
                    "preview": records[:preview_count],
                    "sheetNotes": notes,
                    "note": note,
                    "warnings": warnings,
                },
                ensure_ascii=False,
            )
        )
        return 0

    explicit_header = options.get("headerRow")
    if isinstance(explicit_header, int) and explicit_header >= 1:
        header_row = explicit_header
        _, hits = score_header_row(
            next(ws.iter_rows(min_row=header_row, max_row=header_row, values_only=True), ()),
        )
    else:
        _, header_row, hits = detect_header(ws)

    header_values = next(ws.iter_rows(min_row=header_row, max_row=header_row, values_only=True), ())
    headers = []
    mapping = {}
    unmapped = []
    for index, raw in enumerate(header_values):
        text = cell_text(raw)
        field = alias_index.get(norm_key(text)) if text else None
        if field is not None and field not in mapping:
            mapping[field] = text
        elif text:
            unmapped.append(text)
        headers.append({"index": index, "text": text, "field": field})

    # Positional fallback for a headerless or unrecognised sheet.
    if "date" not in mapping and "start" not in mapping:
        warnings.append("未识别到日期/时间列，请手动指定列映射。")

    field_index = {}
    for header in headers:
        field = header["field"]
        if field and field not in field_index:
            field_index[field] = header["index"]

    def value_of(row, field):
        index = field_index.get(field)
        if index is None or index >= len(row):
            return None
        return row[index]

    rows = []
    last_date = None
    scanned = 0
    for excel_row, row in enumerate(
        ws.iter_rows(min_row=header_row + 1, values_only=True), start=header_row + 1
    ):
        scanned += 1
        texts = [cell_text(cell) for cell in row]
        if all(text == "" for text in texts):
            continue

        row_warnings = []
        record = {"_row": excel_row}

        for field in FIELD_ALIASES:
            record[field] = cell_text(value_of(row, field))

        # A combined date+time cell: split it before parsing each half.
        if record.get("start"):
            date_part, time_part = split_datetime_cell(record["start"])
            if date_part is not None:
                if not record.get("date"):
                    record["date"] = date_part
                record["start"] = time_part

        iso_date, date_warning = parse_date(value_of(row, "date"))
        if iso_date is None and record.get("date"):
            iso_date, date_warning = parse_date(record["date"])
        if iso_date is None:
            # Merged date cells leave later rows blank: carry the previous date.
            if last_date is not None and (record.get("start") or record.get("title")):
                iso_date = last_date
                row_warnings.append("日期沿用上一行 %s" % last_date)
            elif date_warning:
                row_warnings.append(date_warning)
        if iso_date is not None:
            last_date = iso_date
        record["date"] = iso_date or ""

        start, start_warning = parse_time(value_of(row, "start"))
        if start is None and record.get("start"):
            start, start_warning = parse_time(record["start"])
        record["start"] = start or ""
        if start_warning:
            row_warnings.append(start_warning)

        end, end_warning = parse_time(value_of(row, "end"))
        record["end"] = end or ""
        if end_warning:
            row_warnings.append(end_warning)

        minutes, duration_warning = parse_duration_minutes(value_of(row, "duration"))
        record["durationMinutes"] = minutes
        if duration_warning:
            row_warnings.append(duration_warning)

        # Collect unmapped-but-non-empty cells so nothing silently disappears.
        extras = {}
        for header in headers:
            if header["field"] is not None:
                continue
            index = header["index"]
            if index < len(texts) and texts[index] != "":
                extras[header["text"] or ("列%d" % (index + 1))] = texts[index]
        record["extras"] = extras

        record["_warnings"] = row_warnings
        rows.append(record)

    preview_count = options.get("previewRows")
    if not isinstance(preview_count, int) or preview_count < 0:
        preview_count = 12

    person_source = " + ".join(mapping.get(field, field) for field in PERSON_FIELDS if field in mapping)
    if person_source:
        warnings.append("姓名来源列：%s" % person_source)
    else:
        warnings.append("未找到姓名/参会人列，无法按名字过滤。")

    print(
        json.dumps(
            {
                "ok": True,
                "file": path,
                "sheets": sheet_names,
                "sheet": ws.title,
                "layout": "records",
                "headerRow": header_row,
                "rowCount": len(rows),
                "scannedRows": scanned,
                "headers": headers,
                "mapping": mapping,
                "unmapped": unmapped,
                "rows": rows,
                "preview": rows[:preview_count],
                "warnings": warnings,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
