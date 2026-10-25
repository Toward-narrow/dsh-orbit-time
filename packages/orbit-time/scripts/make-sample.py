#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate a realistic Chinese schedule workbook for testing the importer.

Shape mirrors a school/office roster exported from Excel: a title row, a blank
row, a two-level header on row 3, then one row per session with a merged date
column and several 姓名 values in one cell.

Usage: python make-sample.py <output.xlsx>
"""

import datetime as dt
import sys

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font
from openpyxl.utils import get_column_letter

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else 'sample-schedule.xlsx'
    today = dt.date.today()

    wb = Workbook()
    ws = wb.active
    ws.title = '总课表'

    ws['A1'] = '2026 春季学期 · 值班与课程安排表'
    ws['A1'].font = Font(bold=True, size=14)
    ws.merge_cells('A1:H1')

    headers = ['日期', '星期', '开始时间', '结束时间', '事项', '姓名', '地点', '备注', '签到码']
    for index, text in enumerate(headers, start=1):
        cell = ws.cell(row=3, column=index, value=text)
        cell.font = Font(bold=True)
        cell.alignment = Alignment(horizontal='center')

    rows = [
        # date, weekday, start, end, title, people, place, note, code
        (today, '周一', '09:00', '10:30', '高等数学 A', '张三、李四', '三教 305', '带上次作业', 'MATH-01'),
        (today, '周一', '14:00', '15:30', '项目周会', '王五, 张三', '线上腾讯会议', '链接见邮件', 'MTG-02'),
        (today, '周一', '19:00', '20:00', '晚自习辅导', '赵六', '图书馆 2F', '', 'TUT-03'),
        (today + dt.timedelta(days=1), '周二', '08:00', '09:40', '数据结构实验', '张三', '实验楼 B210', '提前装好环境', 'DS-04'),
        (today + dt.timedelta(days=1), '周二', dt.time(13, 30), dt.time(15, 0), '线性代数', '张三、孙七', '一教 101', '', 'LA-05'),
        (today + dt.timedelta(days=2), '周三', '9:00', '10:00', '1:1 沟通', '张三', '会议室 A', '准备季度目标', 'O2O-06'),
        (today + dt.timedelta(days=3), '周四', '上午9:30', '11:00', '教研活动', '全体教师', '阶梯教室', '张三负责记录', 'RES-07'),
        (today + dt.timedelta(days=4), '周五', '15:00', '', '客户拜访', '张三', '客户现场', '打车前往', 'VIP-08'),
    ]

    for offset, row in enumerate(rows):
        excel_row = 4 + offset
        date_value = row[0]
        ws.cell(row=excel_row, column=1, value=date_value).number_format = 'yyyy-mm-dd'
        ws.cell(row=excel_row, column=2, value=row[1])
        ws.cell(row=excel_row, column=3, value=row[2])
        ws.cell(row=excel_row, column=4, value=row[3])
        ws.cell(row=excel_row, column=5, value=row[4])
        ws.cell(row=excel_row, column=6, value=row[5])
        ws.cell(row=excel_row, column=7, value=row[6])
        ws.cell(row=excel_row, column=8, value=row[7])
        ws.cell(row=excel_row, column=9, value=row[8])

    # A merged date block: three sessions sharing one date cell, exactly the
    # shape that trips up naive parsers.
    merge_start = 4 + len(rows)
    shared_date = today + dt.timedelta(days=5)
    ws.cell(row=merge_start, column=1, value=shared_date).number_format = 'yyyy-mm-dd'
    sessions = [
        ('10:00', '11:00', '集中培训 · 第一讲', '张三、李四、王五', '报告厅', '', 'TR-09'),
        ('13:00', '14:00', '集中培训 · 第二讲', '张三', '报告厅', '', 'TR-10'),
        ('15:30', '16:30', '集中培训 · 复盘', '李四', '报告厅', '不含张三', 'TR-11'),
    ]
    for offset, session in enumerate(sessions):
        excel_row = merge_start + offset
        if offset > 0:
            ws.cell(row=excel_row, column=1, value=None)
        ws.cell(row=excel_row, column=2, value='周六')
        ws.cell(row=excel_row, column=3, value=session[0])
        ws.cell(row=excel_row, column=4, value=session[1])
        ws.cell(row=excel_row, column=5, value=session[2])
        ws.cell(row=excel_row, column=6, value=session[3])
        ws.cell(row=excel_row, column=7, value=session[4])
        ws.cell(row=excel_row, column=8, value=session[5])
        ws.cell(row=excel_row, column=9, value=session[6])
    ws.merge_cells(
        start_row=merge_start,
        start_column=1,
        end_row=merge_start + len(sessions) - 1,
        end_column=1,
    )

    widths = [12, 8, 10, 10, 26, 22, 18, 22, 12]
    for index, width in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(index)].width = width

    # A second sheet that must NOT be chosen (no recognisable header).
    other = wb.create_sheet('说明')
    other['A1'] = '本文件由教务系统导出，请勿手动修改列顺序。'
    other['A3'] = '如有疑问联系教务处。'

    wb.save(out)
    print(out)


if __name__ == '__main__':
    main()
