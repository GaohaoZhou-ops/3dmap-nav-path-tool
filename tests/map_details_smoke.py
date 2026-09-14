import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:22069")
ROOT = Path(__file__).resolve().parents[1]
MAP_FIXTURE = ROOT / "tests/fixtures/rotation-map.ply"


def assert_axis(dialog, axis, expected_min, expected_max, expected_span):
    row = dialog.locator(f'[data-axis="{axis}"]')
    assert row.count() == 1
    assert abs(float(row.get_attribute("data-min")) - expected_min) < 1e-6
    assert abs(float(row.get_attribute("data-max")) - expected_max) < 1e-6
    assert abs(float(row.get_attribute("data-span")) - expected_span) < 1e-6


def run():
    page_errors = []
    console_errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(120_000)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )

        page.goto(BASE_URL, wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        details_button = page.get_by_role("button", name="查看地图详细信息")
        assert details_button.is_disabled()

        page.locator('input[type="file"][accept=".ply"]').set_input_files(str(MAP_FIXTURE))
        page.locator(".loading-curtain").wait_for(state="hidden")
        assert details_button.is_enabled()

        heading_buttons = page.locator(".panel-3d .panel-heading > button")
        assert heading_buttons.count() == 2
        assert heading_buttons.nth(0).get_attribute("aria-label") == "查看地图详细信息"
        assert heading_buttons.nth(1).get_attribute("aria-label") == "折叠3D窗口"
        page.screenshot(path="/tmp/atlas-map-details-trigger.png", full_page=True)

        details_button.click()
        dialog = page.get_by_role("dialog", name="地图详细信息")
        dialog.wait_for()
        assert dialog.get_attribute("data-map-name") == MAP_FIXTURE.name
        assert int(float(dialog.get_attribute("data-map-byte-length"))) == MAP_FIXTURE.stat().st_size
        assert int(float(dialog.get_attribute("data-map-point-count"))) == 24
        assert int(float(dialog.get_attribute("data-map-face-count"))) == 0
        assert dialog.get_attribute("data-map-source-kind") == "local-file"
        modified_at = dialog.get_attribute("data-map-modified-at")
        assert modified_at
        assert dialog.get_by_text("本地文件选择器", exact=True).is_visible()
        assert dialog.get_by_text("PLY 实时解析", exact=True).is_visible()
        assert dialog.get_by_role("table", name="XYZ坐标范围").is_visible()
        assert_axis(dialog, "x", -1.4, 4.7, 6.1)
        assert_axis(dialog, "y", -1.5, 2.0, 3.5)
        assert_axis(dialog, "z", 0.0, 4.4, 4.4)
        dialog.screenshot(path="/tmp/atlas-map-details.png")

        page.keyboard.press("Escape")
        dialog.wait_for(state="detached")
        assert details_button.evaluate("node => node === document.activeElement")

        page.reload(wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        assert page.locator(".three-canvas").get_attribute("data-geometry-source") == "session-cache"
        page.get_by_role("button", name="查看地图详细信息").click()
        restored_dialog = page.get_by_role("dialog", name="地图详细信息")
        restored_dialog.wait_for()
        assert int(float(restored_dialog.get_attribute("data-map-byte-length"))) == MAP_FIXTURE.stat().st_size
        assert restored_dialog.get_attribute("data-map-modified-at") == modified_at
        assert restored_dialog.get_attribute("data-map-source-kind") == "local-file"
        assert restored_dialog.get_by_text("会话几何缓存直载", exact=True).is_visible()
        restored_dialog.get_by_role("button", name="关闭地图详细信息").click()
        restored_dialog.wait_for(state="detached")

        assert page_errors == []
        assert console_errors == []
        print("map_name=", MAP_FIXTURE.name)
        print("map_bytes=", MAP_FIXTURE.stat().st_size)
        print("modified_at=", modified_at)
        print("page_errors=", page_errors)
        print("console_errors=", console_errors)
        browser.close()


if __name__ == "__main__":
    run()
