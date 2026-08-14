#!/usr/bin/env python3
"""Build the deterministic public QR signs and paper fallback packet."""

from __future__ import annotations

import argparse
import hashlib
import io
import shutil
from dataclasses import dataclass
from pathlib import Path

import cv2
import fitz
import numpy as np
from PIL import Image

BASE_URL = "http://192.168.1.101:8790"
PDF_NAME = "junkyard-olympics-public-print-packet.pdf"
LETTER = (612, 792)
DPI = 300
FALLBACK_TABLE_TOP = 150
FALLBACK_ROW_HEIGHT = 40
FALLBACK_ROWS = 11
FALLBACK_NOTES_TOP = 655
BLACK = (0.04, 0.04, 0.03)
WHITE = (1, 1, 1)
YELLOW = (1, 0.78, 0.02)
GRAY = (0.90, 0.90, 0.87)


@dataclass(frozen=True)
class Station:
    id: str
    name: str
    game: str

    @property
    def url(self) -> str:
        return f"{BASE_URL}/station/{self.id}"


STATIONS = (
    Station("station-1", "The Crusher", "Ladder Ball"),
    Station("station-2", "Scrap Heap Two", "Field Pong"),
    Station("station-3", "Sack Attack", "Cornhole"),
    Station("station-4", "Can Crusher Court", "KanJam"),
    Station("station-5", "Flight Risk", "Lawn Darts"),
    Station("station-6", "The Gravel Pit", "Bocce Ball"),
    Station("station-7", "Strike Yard", "Volley Strike"),
    Station("station-8", "Washer Wreck", "Washers"),
)
PUBLIC_URLS = [BASE_URL + "/"] + [station.url for station in STATIONS]
PAGE_TITLES = [
    "Packet Index",
    "Event Signup",
    *[f"{station.name} - {station.game}" for station in STATIONS],
    *[f"Paper Score & Check-In - {station.game}" for station in STATIONS],
    "Junkyard Cannon - Lane 1 Paper Ledger",
    "Junkyard Cannon - Lane 2 Paper Ledger",
]


def _text(
    page: fitz.Page,
    rect: fitz.Rect,
    value: str,
    size: float,
    *,
    bold: bool = False,
    color: tuple[float, float, float] = BLACK,
    align: int = fitz.TEXT_ALIGN_LEFT,
    lineheight: float = 1.15,
) -> None:
    remaining = page.insert_textbox(
        rect,
        value,
        fontsize=size,
        fontname="hebo" if bold else "helv",
        color=color,
        align=align,
        lineheight=lineheight,
    )
    if remaining < 0:
        raise RuntimeError(f"Text overflow ({remaining:.1f}): {value!r}")


def _page_title(page: fitz.Page, title: str, kicker: str) -> None:
    # Insert the title first so PDF extraction preserves the contracted page order.
    _text(page, fitz.Rect(36, 28, 576, 62), title, 22, bold=True)
    page.draw_rect(fitz.Rect(0, 0, 612, 18), color=YELLOW, fill=YELLOW)
    _text(page, fitz.Rect(36, 65, 576, 88), kicker.upper(), 9, bold=True, color=(0.25, 0.25, 0.23))
    page.draw_line(fitz.Point(36, 92), fitz.Point(576, 92), color=BLACK, width=3)


def _footer(page: fitz.Page, page_number: int) -> None:
    page.draw_line(fitz.Point(36, 756), fitz.Point(576, 756), color=BLACK, width=1)
    _text(page, fitz.Rect(36, 761, 500, 780), "JUNKYARD OLYMPICS · PUBLIC PAPER PACKET", 7, bold=True)
    _text(page, fitz.Rect(500, 761, 576, 780), f"PAGE {page_number:02d}/20", 7, bold=True, align=fitz.TEXT_ALIGN_RIGHT)


def _qr_png(value: str) -> bytes:
    matrix = cv2.QRCodeEncoder_create().encode(value)
    # Four-module quiet zone is part of the QR scan contract.
    matrix = np.pad(matrix, 4, constant_values=255)
    image = Image.fromarray(matrix, mode="L").resize((1480, 1480), Image.Resampling.NEAREST)
    stream = io.BytesIO()
    image.save(stream, format="PNG", optimize=False, compress_level=9)
    return stream.getvalue()


def _sign_page(doc: fitz.Document, page_number: int, title: str, subtitle: str, url: str, label: str) -> None:
    page = doc.new_page(width=LETTER[0], height=LETTER[1])
    _page_title(page, title, label)
    _text(page, fitz.Rect(36, 105, 576, 154), subtitle, 30, bold=True, align=fitz.TEXT_ALIGN_CENTER)
    page.draw_rect(fitz.Rect(155, 166, 457, 468), color=BLACK, width=2, fill=WHITE)
    page.insert_image(fitz.Rect(162, 173, 450, 461), stream=_qr_png(url), keep_proportion=True)
    _text(
        page,
        fitz.Rect(62, 485, 550, 554),
        "ONE TEAMMATE PER TEAM SCANS\nON THEIR OWN PHONE",
        20,
        bold=True,
        align=fitz.TEXT_ALIGN_CENTER,
        lineheight=1.08,
    )
    page.draw_rect(fitz.Rect(48, 568, 564, 650), color=BLACK, fill=YELLOW, width=2)
    _text(page, fitz.Rect(61, 580, 551, 600), "CAN'T SCAN? TYPE THIS PUBLIC ADDRESS:", 10, bold=True, align=fitz.TEXT_ALIGN_CENTER)
    _text(page, fitz.Rect(55, 610, 557, 642), url, 15, bold=True, align=fitz.TEXT_ALIGN_CENTER)
    _text(page, fitz.Rect(74, 675, 538, 718), "Reusable public check-in sign · no login code required", 12, align=fitz.TEXT_ALIGN_CENTER)
    _footer(page, page_number)


def _index_page(doc: fitz.Document) -> None:
    page = doc.new_page(width=LETTER[0], height=LETTER[1])
    _page_title(page, PAGE_TITLES[0], "Print/copy order · US Letter · 300 DPI PNG set")
    _text(page, fitz.Rect(36, 105, 576, 140), "PUBLIC SIGNS", 16, bold=True)
    public_lines = ["02  Event Signup - public home URL"] + [
        f"{index + 3:02d}  {station.name} - {station.game} - /station/{station.id}"
        for index, station in enumerate(STATIONS)
    ]
    _text(page, fitz.Rect(48, 143, 570, 338), "\n".join(public_lines), 11, lineheight=1.38)
    _text(page, fitz.Rect(36, 350, 576, 380), "PAPER FALLBACK", 16, bold=True)
    fallback_lines = [
        f"{index + 11:02d}  {station.game} score & check-in"
        for index, station in enumerate(STATIONS)
    ] + ["19  Junkyard Cannon - Lane 1 ledger", "20  Junkyard Cannon - Lane 2 ledger"]
    _text(page, fitz.Rect(48, 386, 570, 590), "\n".join(fallback_lines), 11, lineheight=1.38)
    page.draw_rect(fitz.Rect(36, 600, 576, 708), color=BLACK, fill=GRAY, width=2)
    _text(
        page,
        fitz.Rect(50, 614, 562, 698),
        "Horseshoes - CASUAL ONLY - no station QR\nBadminton - CASUAL ONLY - no station QR\n\nCannon uses this two-lane paper ledger; it has no field-station QR.",
        12,
        bold=True,
        lineheight=1.25,
    )
    _footer(page, 1)


def _table(page: fitz.Page, top: float, headers: list[str], widths: list[float], rows: int, row_height: float) -> None:
    left = 36.0
    right = 576.0
    x_positions = [left]
    for width in widths:
        x_positions.append(x_positions[-1] + width)
    if abs(x_positions[-1] - right) > 0.1:
        raise ValueError("Table widths must total 540 points")
    page.draw_rect(fitz.Rect(left, top, right, top + row_height), color=BLACK, fill=BLACK)
    for index, header in enumerate(headers):
        _text(page, fitz.Rect(x_positions[index] + 4, top + 5, x_positions[index + 1] - 4, top + row_height - 2), header, 8, bold=True, color=WHITE)
    for row in range(rows + 1):
        y = top + row_height * (row + 1)
        page.draw_line(fitz.Point(left, y), fitz.Point(right, y), color=BLACK, width=0.8)
    for x in x_positions:
        page.draw_line(fitz.Point(x, top), fitz.Point(x, top + row_height * (rows + 1)), color=BLACK, width=0.8)


def _fallback_page(doc: fitz.Document, page_number: int, station: Station) -> None:
    page = doc.new_page(width=LETTER[0], height=LETTER[1])
    title = f"Paper Score & Check-In - {station.game}"
    _page_title(page, title, f"{station.name} · Wi-Fi fallback only")
    _text(page, fitz.Rect(36, 106, 576, 138), "How to use: check both teams in, record the final score, circle the winner, then collect initials.", 10, bold=True)
    _table(
        page,
        FALLBACK_TABLE_TOP,
        ["#", "TEAM A / CHECK-IN", "TEAM B / CHECK-IN", "FINAL SCORE", "WINNER", "INITIALS / TIME"],
        [28, 125, 125, 75, 75, 112],
        rows=FALLBACK_ROWS,
        row_height=FALLBACK_ROW_HEIGHT,
    )
    _text(page, fitz.Rect(36, FALLBACK_NOTES_TOP, 576, 679), "Dispute / replay notes", 11, bold=True)
    for y in (690, 712, 734):
        page.draw_line(fitz.Point(36, y), fitz.Point(576, y), color=(0.35, 0.35, 0.35), width=0.7)
    _footer(page, page_number)


def _cannon_page(doc: fitz.Document, page_number: int, lane: int) -> None:
    page = doc.new_page(width=LETTER[0], height=LETTER[1])
    title = f"Junkyard Cannon - Lane {lane} Paper Ledger"
    _page_title(page, title, "Opening event · separate physical lane ledger")
    _text(page, fitz.Rect(36, 106, 576, 143), "Record each completed shot before the next one. Use one row per participant shot.", 11, bold=True)
    _table(
        page,
        150,
        ["#", "PARTICIPANT / TEAM", "SHOT", "TARGET HIT(S)", "CARNAGE", "TOTAL", "INITIALS"],
        [28, 125, 42, 128, 65, 65, 87],
        rows=13,
        row_height=38,
    )
    _text(page, fitz.Rect(36, 664, 576, 689), "Target values / range notes", 11, bold=True)
    for y in (700, 720, 740):
        page.draw_line(fitz.Point(36, y), fitz.Point(576, y), color=(0.35, 0.35, 0.35), width=0.7)
    _footer(page, page_number)


def build_pdf(path: Path) -> None:
    doc = fitz.open()
    _index_page(doc)
    _sign_page(doc, 2, "Event Signup", "JOIN THE JUNKYARD OLYMPICS", PUBLIC_URLS[0], "Public signup")
    for index, station in enumerate(STATIONS, start=3):
        _sign_page(doc, index, f"{station.name} - {station.game}", station.game.upper(), station.url, f"Station {index - 2} public check-in")
    for index, station in enumerate(STATIONS, start=11):
        _fallback_page(doc, index, station)
    _cannon_page(doc, 19, 1)
    _cannon_page(doc, 20, 2)
    doc.set_metadata(
        {
            "title": "Junkyard Olympics Public Print Packet",
            "author": "Junkyard Olympics",
            "subject": "Eight public station QR signs and paper fallback ledgers",
            "creator": "tools/print_packet/generate.py",
            "producer": "PyMuPDF 1.28.0",
            "creationDate": "D:20260814000000Z",
            "modDate": "D:20260814000000Z",
        }
    )
    doc.save(path, garbage=4, deflate=True, no_new_id=True, compression_effort=9)
    doc.close()


def rasterize(pdf_path: Path, pages_path: Path) -> None:
    pages_path.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(pdf_path)
    matrix = fitz.Matrix(DPI / 72, DPI / 72)
    for index, page in enumerate(doc, start=1):
        pixmap = page.get_pixmap(matrix=matrix, colorspace=fitz.csRGB, alpha=False)
        image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
        image.save(
            pages_path / f"page-{index:02d}.png",
            format="PNG",
            optimize=False,
            compress_level=1,
        )
    doc.close()


def write_manifest(output: Path) -> None:
    artifact_paths = [Path(PDF_NAME)] + [Path("pages") / f"page-{page:02d}.png" for page in range(1, 21)]
    lines = [
        "JUNKYARD OLYMPICS PUBLIC PRINT PACKET MANIFEST",
        "DO NOT DEPLOY OR PRINT AUTOMATICALLY",
        "",
        "COPY/PRINT ORDER",
    ]
    lines.extend(f"{index:02d}  {title}" for index, title in enumerate(PAGE_TITLES, start=1))
    lines.extend(["", "PUBLIC QR URLS"])
    lines.extend(PUBLIC_URLS)
    lines.extend(["", "SHA-256 (paths relative to this manifest)"])
    for relative in artifact_paths:
        digest = hashlib.sha256((output / relative).read_bytes()).hexdigest()
        lines.append(f"{digest}  {relative.as_posix()}")
    lines.append("")
    (output / "MANIFEST.txt").write_text("\n".join(lines), encoding="utf-8", newline="\n")


def generate(output: Path) -> None:
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    pdf_path = output / PDF_NAME
    build_pdf(pdf_path)
    rasterize(pdf_path, output / "pages")
    write_manifest(output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "artifacts" / "public-print-packet",
        help="output directory (replaced atomically enough for local artifact generation)",
    )
    args = parser.parse_args()
    generate(args.output.resolve())
    print(args.output.resolve() / PDF_NAME)
    print(args.output.resolve() / "MANIFEST.txt")


if __name__ == "__main__":
    main()
