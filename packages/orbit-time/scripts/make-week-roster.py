#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate a 「第N周」 duty roster whose weekday headers are merged cells.

This is the shape that broke the importer: every weekday header is one merged
cell spanning two duty slots ("周一" over two columns), so only the header's
first column carries text while both columns can carry names.

The generated content is deliberately *sensitive to the bug*: the duty row holds
a single name per weekday, and that name sits in a different slot each week —
week 1 puts it in each weekday's first column, week 2 in the second, and so on.
A parser that reads only the header column therefore finds a name in week 1 and
nothing afterwards, which is exactly the "your name is in the sheet but never
matches" failure. With the span read correctly, every week yields one record.

Usage: python make-week-roster.py <output.xlsx> [weeks] [prose]
"""

import sys

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font

WEEKDAYS = ['周一', '周二', '周三', '周四']
SLOTS_PER_WEEKDAY = 2

# What a real roster writes beside the grid: the rooms, the clock it runs on, and
# the duties of whoever is on. A tall merged cell on the right, exactly like the
# 考勤负责人注意事项 column in the real 晚自习 sheet.
PROSE = [
    '教室：3班：A101 4班：A102',
    '点名时间：19：30 20：50',
    '考勤负责人注意事项：',
    '①一人负责两个班的晚自习考勤（教室在东区）',
    '②点名前先和班委要当晚的考勤记录',
]


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else 'week-roster.xlsx'
    weeks = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    modes = set(sys.argv[3:])
    with_prose = 'prose' in modes
    # `uniform` puts the same name in every slot of every week, so the roster has
    # entries in the future no matter which week the anchor points at. The
    # default deliberately shifts the name between slots each week, which is what
    # the merged-header checks need — but it also means later weeks hold *other*
    # names, so a fixture built on it only has week-1 rows inside the import
    # horizon.
    uniform = 'uniform' in modes
    last_col = len(WEEKDAYS) * SLOTS_PER_WEEKDAY

    wb = Workbook()
    ws = wb.active
    ws.title = 'Sheet1'

    ws['A1'] = '教室：3班 A101  4班 A102'
    ws.merge_cells('A1:D1')
    ws['A1'].font = Font(bold=True)

    if with_prose:
        notes_col = last_col + 2
        ws.cell(row=1, column=notes_col, value='\n'.join(PROSE))
        ws.merge_cells(start_row=1, start_column=notes_col, end_row=weeks * 3 + 2, end_column=notes_col)

    row = 2
    for week in range(1, weeks + 1):
        # The week label goes in column A and the merge starts at B: openpyxl
        # clears every cell of a merged range except its top-left, and on a
        # single row it treats the *leftmost* cell as that top-left — so merging
        # A:H would wipe the very label being written.
        ws.cell(row=row, column=1, value='第%d周' % week).font = Font(bold=True)
        ws.merge_cells(start_row=row, start_column=2, end_row=row, end_column=last_col)
        row += 1

        # One merged header cell per weekday, covering its two duty slots.
        for index, weekday in enumerate(WEEKDAYS):
            col = 1 + index * SLOTS_PER_WEEKDAY
            ws.cell(row=row, column=col, value=weekday).alignment = Alignment(horizontal='center')
            ws.merge_cells(start_row=row, start_column=col, end_row=row, end_column=col + 1)
        row += 1

        # One name per weekday, walking one slot to the right each week. The name
        # deliberately avoids the 「第N周」 shape: a duty cell containing a week
        # label is a *block marker* to the parser, not a person.
        slot = (week - 1) % SLOTS_PER_WEEKDAY
        for index in range(len(WEEKDAYS)):
            col = 1 + index * SLOTS_PER_WEEKDAY + slot
            ws.cell(row=row, column=col, value='值班员1号' if uniform else '值班员%d号' % week)
        row += 1

    wb.save(out)
    print(out)


if __name__ == '__main__':
    main()
