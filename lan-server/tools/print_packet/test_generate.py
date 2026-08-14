from __future__ import annotations

import hashlib
import importlib.util
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

import cv2
import fitz
import pytest

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
GENERATOR_PATH = HERE / "generate.py"
EXPECTED_STATIONS = [
    ("station-1", "The Crusher", "Ladder Ball"),
    ("station-2", "Scrap Heap Two", "Field Pong"),
    ("station-3", "Sack Attack", "Cornhole"),
    ("station-4", "Can Crusher Court", "KanJam"),
    ("station-5", "Flight Risk", "Lawn Darts"),
    ("station-6", "The Gravel Pit", "Bocce Ball"),
    ("station-7", "Strike Yard", "Volley Strike"),
    ("station-8", "Washer Wreck", "Washers"),
]
BASE_URL = "http://192.168.1.101:8790"
EXPECTED_URLS = [BASE_URL + "/"] + [
    f"{BASE_URL}/station/{station_id}" for station_id, _, _ in EXPECTED_STATIONS
]
EXPECTED_PAGE_TITLES = [
    "Packet Index",
    "Event Signup",
    *[f"{name} - {game}" for _, name, game in EXPECTED_STATIONS],
    *[f"Paper Score & Check-In - {game}" for _, _, game in EXPECTED_STATIONS],
    "Junkyard Cannon - Lane 1 Paper Ledger",
    "Junkyard Cannon - Lane 2 Paper Ledger",
]


def load_generator():
    spec = importlib.util.spec_from_file_location("print_packet_generate", GENERATOR_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def generate_into(path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(GENERATOR_PATH), "--output", str(path)],
        cwd=REPO,
        check=True,
        text=True,
        capture_output=True,
    )


@pytest.fixture(scope="session")
def artifact_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    output = tmp_path_factory.mktemp("public-print-packet") / "packet"
    load_generator().generate(output)
    return output


def decode_qr(path: Path) -> str:
    image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    assert image is not None, path
    height, width = image.shape
    # QR placement is fixed; crop the known sign region before invoking OpenCV's
    # comparatively expensive detector. This still decodes the generated pixels.
    if (width, height) == (2550, 3300):
        image = image[680:1950, 650:1900]
    elif width >= 1200 and height >= 1500:
        image = image[330:950, 300:930]
    if max(image.shape) > 900:
        scale = 900 / max(image.shape)
        image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    value, points, _ = cv2.QRCodeDetector().detectAndDecode(image)
    assert points is not None and value, f"QR did not decode: {path}"
    return value


def assert_public_url(url: str) -> None:
    parsed = urlsplit(url)
    assert parsed.scheme == "http"
    assert parsed.netloc == "192.168.1.101:8790"
    assert parsed.username is None and parsed.password is None
    assert parsed.query == ""
    assert parsed.fragment == ""
    assert not re.search(r"organizer|token|credential|secret|bearer|auth", url, re.I)


def test_catalog_and_page_contract_are_exact():
    module = load_generator()
    assert [(s.id, s.name, s.game) for s in module.STATIONS] == EXPECTED_STATIONS
    assert module.PUBLIC_URLS == EXPECTED_URLS
    assert module.PAGE_TITLES == EXPECTED_PAGE_TITLES
    assert len(module.PAGE_TITLES) == 20
    assert len(set(module.PUBLIC_URLS)) == 9
    for url in module.PUBLIC_URLS:
        assert_public_url(url)


def test_generated_qrs_decode_to_exact_public_lan_urls(artifact_dir: Path, tmp_path: Path):
    qr_pages = [artifact_dir / "pages" / f"page-{page:02d}.png" for page in range(2, 11)]
    assert [decode_qr(path) for path in qr_pages] == EXPECTED_URLS

    pdf = fitz.open(artifact_dir / "junkyard-olympics-public-print-packet.pdf")
    decoded_from_pdf = []
    for page_number in range(1, 10):
        pix = pdf[page_number].get_pixmap(matrix=fitz.Matrix(2, 2), colorspace=fitz.csGRAY, alpha=False)
        image_path = tmp_path / f"pdf-qr-{page_number + 1:02d}.png"
        pix.save(image_path)
        decoded_from_pdf.append(decode_qr(image_path))
    assert decoded_from_pdf == EXPECTED_URLS


def test_pdf_page_order_letter_size_and_png_readability(artifact_dir: Path):
    pdf = fitz.open(artifact_dir / "junkyard-olympics-public-print-packet.pdf")
    assert len(pdf) == len(EXPECTED_PAGE_TITLES)
    assert [page.get_text("text").splitlines()[0] for page in pdf] == EXPECTED_PAGE_TITLES
    for page in pdf:
        assert abs(page.rect.width - 612) < 0.01
        assert abs(page.rect.height - 792) < 0.01

    pngs = sorted((artifact_dir / "pages").glob("page-*.png"))
    assert len(pngs) == 20
    for png in pngs:
        image = cv2.imread(str(png))
        assert image is not None
        assert (image.shape[1], image.shape[0]) == (2550, 3300)
    # The fixed 288-point QR placement rasterizes to exactly 1,200 px at 300 DPI.
    module = load_generator()
    assert module.DPI == 300
    assert round(288 * module.DPI / 72) == 1200


def test_paper_sheet_table_does_not_overlap_notes():
    module = load_generator()
    table_bottom = module.FALLBACK_TABLE_TOP + module.FALLBACK_ROW_HEIGHT * (module.FALLBACK_ROWS + 1)
    assert table_bottom <= module.FALLBACK_NOTES_TOP - 10


def test_artifacts_contain_no_organizer_or_url_credentials(artifact_dir: Path):
    pdf = fitz.open(artifact_dir / "junkyard-olympics-public-print-packet.pdf")
    text = "\n".join(page.get_text("text") for page in pdf)
    normalized_text = " ".join(text.lower().split())
    assert "one teammate per team scans on their own phone" in normalized_text
    assert "Horseshoes - CASUAL ONLY - no station QR" in text
    assert "Badminton - CASUAL ONLY - no station QR" in text
    assert "Cannon uses this two-lane paper ledger; it has no field-station QR." in text
    assert not re.search(r"organizer|bearer|credential|access[_ -]?token|[?&#](token|auth)=", text, re.I)
    for url in re.findall(r"http://\S+", text):
        assert_public_url(url.rstrip(".,)"))


def test_generation_is_byte_reproducible_and_manifest_matches(artifact_dir: Path, tmp_path: Path):
    first, second = artifact_dir, tmp_path / "second"
    load_generator().generate(second)
    first_files = sorted(path.relative_to(first) for path in first.rglob("*") if path.is_file())
    second_files = sorted(path.relative_to(second) for path in second.rglob("*") if path.is_file())
    assert first_files == second_files
    for relative in first_files:
        assert (first / relative).read_bytes() == (second / relative).read_bytes(), relative

    manifest = (first / "MANIFEST.txt").read_text(encoding="utf-8")
    assert "COPY/PRINT ORDER" in manifest
    assert "DO NOT DEPLOY OR PRINT AUTOMATICALLY" in manifest
    for line in manifest.splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        if match:
            digest, relative = match.groups()
            assert hashlib.sha256((first / relative).read_bytes()).hexdigest() == digest
