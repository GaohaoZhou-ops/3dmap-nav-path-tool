import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
ROOT = Path(__file__).resolve().parents[1]


def assert_point_cloud_only(page, canvas):
    assert page.get_by_role("button", name="切换地图显示模式").count() == 0
    assert page.get_by_text("结构面", exact=True).count() == 0
    assert canvas.get_attribute("data-map-render-mode") == "points"
    assert canvas.get_attribute("data-map-point-cloud-visible") == "true"
    assert canvas.get_attribute("data-map-surface-visible") is None
    assert canvas.get_attribute("data-map-surface-status") is None
    assert canvas.get_attribute("data-map-surface-implementation") is None
    assert canvas.get_attribute("data-map-render-isolation") == "scene-map-only"


def run():
    page_errors = []
    console_errors = []
    surface_requests = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(180_000)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        page.on(
            "request",
            lambda request: surface_requests.append(request.url)
            if "/__atlas/surfaces/" in request.url
            else None,
        )

        page.goto(BASE_URL, wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator('input[type="file"][accept=".ply"]').set_input_files(
            str(ROOT / "tests/fixtures/rotation-map.ply")
        )
        canvas = page.get_by_label("三维点云交互画布")
        canvas.wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        assert_point_cloud_only(page, canvas)

        page.get_by_role("button", name="加载机器人", exact=True).click()
        page.get_by_role("option", name="加载机器人 botx_abx_zivid_m70").click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'"
        )
        assert canvas.get_attribute("data-robot-layer-visible") == "true"
        assert_point_cloud_only(page, canvas)

        page.reload(wait_until="domcontentloaded")
        page.locator('[data-session-state="ready"]').wait_for()
        canvas = page.get_by_label("三维点云交互画布")
        canvas.wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        assert_point_cloud_only(page, canvas)
        page.screenshot(path="/tmp/atlas-point-cloud-only.png", full_page=True)

        print("map_render_mode=", canvas.get_attribute("data-map-render-mode"))
        print("surface_requests=", surface_requests)
        print("page_errors=", page_errors)
        print("console_errors=", console_errors)
        assert not surface_requests
        assert not page_errors
        assert not console_errors
        browser.close()


if __name__ == "__main__":
    run()
