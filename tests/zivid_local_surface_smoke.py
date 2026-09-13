import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
ROOT = Path(__file__).resolve().parents[1]


def run():
    page_errors = []
    console_errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1500, "height": 940})
        page.set_default_timeout(180_000)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )

        page.goto(BASE_URL, wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator('input[type="file"][accept=".ply"]').set_input_files(
            str(ROOT / "tests/fixtures/hybrid-camera-surface-map.ply")
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.get_by_role("button", name="加载机器人", exact=True).click()
        page.get_by_role("option", name="加载机器人 botx_abx_zivid_m70").click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )
        page.get_by_role("tab", name="虚拟示教与相机").click()
        page.wait_for_function(
            "document.querySelector('.zivid-camera-canvas')?.dataset.contextState === 'ready'"
        )

        panel = page.get_by_label("Zivid 2 M70 相机视图", exact=True)
        canvas = panel.get_by_label("Zivid 2 M70 仿真相机画面", exact=True)
        assert canvas.get_attribute("data-camera-mesh-candidate-face-count") == "0"
        assert int(canvas.get_attribute("data-rgb-surface-candidate-point-count")) >= 20
        assert int(canvas.get_attribute("data-rgb-surface-point-count")) >= 20
        assert int(canvas.get_attribute("data-rgb-surface-triangle-count")) > 0
        assert canvas.get_attribute("data-rgb-reconstructed-surface-visible") == "true"
        assert canvas.get_attribute("data-rgb-mesh-visible") == "false"
        assert panel.get_attribute("data-rgb-surface-mode") == "embedded-mesh+local-surface"
        assert panel.locator(".zivid-camera-rgb-warning").count() == 0

        panel.screenshot(path="/tmp/atlas-zivid-local-surface.png")
        print("surface_points=", canvas.get_attribute("data-rgb-surface-point-count"))
        print("surface_triangles=", canvas.get_attribute("data-rgb-surface-triangle-count"))
        print("page_errors=", page_errors)
        print("console_errors=", console_errors)
        assert not page_errors
        assert not console_errors
        browser.close()


if __name__ == "__main__":
    run()
