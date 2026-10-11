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


def assert_original_download(page, dialog):
    button = dialog.get_by_role("button", name="下载原始文件", exact=True)
    assert button.is_enabled()
    close = dialog.get_by_role("button", name="关闭", exact=True)
    download_box, close_box = button.bounding_box(), close.bounding_box()
    assert download_box["x"] + download_box["width"] <= close_box["x"]
    with page.expect_download() as pending:
        button.click()
    download = pending.value
    assert download.suggested_filename == MAP_FIXTURE.name
    assert Path(download.path()).read_bytes() == MAP_FIXTURE.read_bytes()
    assert dialog.is_visible()


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

        page.goto(f"{BASE_URL.rstrip('/')}/workbench", wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        details_button = page.get_by_role("button", name="查看地图与工程配置")
        assert details_button.is_disabled()

        page.locator('input[type="file"][accept=".ply"]').set_input_files(str(MAP_FIXTURE))
        page.locator(".loading-curtain").wait_for(state="hidden")
        assert details_button.is_enabled()

        heading_buttons = page.locator(".panel-3d .panel-heading > button")
        assert heading_buttons.count() == 1
        assert heading_buttons.nth(0).get_attribute("aria-label") == "折叠3D窗口"
        navigation_buttons = page.locator(".topbar-actions > button")
        assert navigation_buttons.nth(0).get_attribute("aria-label") == "返回主页面"
        assert navigation_buttons.nth(1).get_attribute("aria-label") == "查看地图与工程配置"
        page.screenshot(path="/tmp/atlas-map-details-trigger.png", full_page=True)

        details_button.click()
        dialog = page.get_by_role("dialog", name="地图与工程配置")
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
        project = dialog.locator(".map-details-project")
        assert project.get_by_text("工程配置", exact=True).is_visible()
        assert project.get_by_text("完整地图", exact=True).is_visible()
        assert project.get_by_text("MAP", exact=True).is_visible()
        assert project.locator(".robot-config-row").inner_text().endswith("尚未加载")
        assert project.get_by_text("截面下限", exact=True).is_visible()
        assert project.get_by_text("截面上限", exact=True).is_visible()
        assert project.get_by_text("截面跨度", exact=True).is_visible()
        assert page.get_by_role("tab", name="工程配置").count() == 0
        assert dialog.get_by_role("table", name="XYZ坐标范围").is_visible()
        assert_axis(dialog, "x", -1.4, 4.7, 6.1)
        assert_axis(dialog, "y", -1.5, 2.0, 3.5)
        assert_axis(dialog, "z", 0.0, 4.4, 4.4)
        assert_original_download(page, dialog)
        dialog.screenshot(path="/tmp/atlas-map-details.png")

        for width, height in [(1600, 900), (1024, 768), (680, 720)]:
            page.set_viewport_size({"width": width, "height": height})
            box = dialog.locator(".map-details-dialog").bounding_box()
            assert 0 <= box["x"] and box["x"] + box["width"] <= width
            assert 0 <= box["y"] and box["y"] + box["height"] <= height
            assert dialog.locator(".map-details-dialog__body").evaluate(
                "node => node.scrollWidth <= node.clientWidth"
            )
            dialog.get_by_role("table", name="XYZ坐标范围").scroll_into_view_if_needed()
            dialog.get_by_role("button", name="下载原始文件", exact=True).scroll_into_view_if_needed()
            assert project.locator("dl").evaluate(
                "node => getComputedStyle(node).gridTemplateColumns.split(' ').length"
            ) == (1 if width <= 720 else 2)
        page.set_viewport_size({"width": 1440, "height": 900})

        page.keyboard.press("Escape")
        dialog.wait_for(state="detached")
        assert details_button.evaluate("node => node === document.activeElement")

        page.reload(wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        assert page.locator(".three-canvas").get_attribute("data-geometry-source") == "session-cache"
        page.get_by_role("button", name="查看地图与工程配置").click()
        restored_dialog = page.get_by_role("dialog", name="地图与工程配置")
        restored_dialog.wait_for()
        assert int(float(restored_dialog.get_attribute("data-map-byte-length"))) == MAP_FIXTURE.stat().st_size
        assert restored_dialog.get_attribute("data-map-modified-at") == modified_at
        assert restored_dialog.get_attribute("data-map-source-kind") == "local-file"
        assert restored_dialog.get_by_text("会话几何缓存直载", exact=True).is_visible()
        assert_original_download(page, restored_dialog)
        restored_dialog.get_by_role("button", name="关闭地图与工程配置").click()
        restored_dialog.wait_for(state="detached")

        # Older geometry-only caches must never offer a reconstructed file as the original.
        page.evaluate("""async () => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('atlas-route-studio', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          await new Promise((resolve, reject) => {
            const transaction = db.transaction('workspace-session', 'readwrite');
            const store = transaction.objectStore('workspace-session');
            const request = store.get('workspace-map:map');
            request.onsuccess = () => {
              const record = request.result;
              delete record.sourceBlob;
              store.put(record);
            };
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
          });
          db.close();
        }""")
        page.reload(wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        details_button.click()
        dialog.wait_for()
        assert dialog.get_by_role("button", name="下载原始文件", exact=True).is_disabled()
        assert dialog.get_by_text("此工程未保留原始文件", exact=True).is_visible()
        dialog.get_by_role("button", name="关闭", exact=True).click()

        assert page_errors == []
        assert console_errors == []
        print("map_name=", MAP_FIXTURE.name)
        print("map_bytes=", MAP_FIXTURE.stat().st_size)
        print("modified_at=", modified_at)
        print("original_download=byte-exact before and after refresh; unavailable for geometry-only caches")
        print("page_errors=", page_errors)
        print("console_errors=", console_errors)
        browser.close()


if __name__ == "__main__":
    run()
