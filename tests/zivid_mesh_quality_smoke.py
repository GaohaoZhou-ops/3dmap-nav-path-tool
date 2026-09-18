import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
ROOT = Path(__file__).resolve().parents[1]


def camera_canvas(panel):
    return panel.get_by_label("Zivid 2 M70 仿真相机画面", exact=True)


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

        page.goto(f"{BASE_URL.rstrip('/')}/workbench", wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator('input[type="file"][accept=".ply"]').set_input_files(
            str(ROOT / "tests/fixtures/hybrid-map.ply")
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        main_canvas = page.get_by_label("三维点云交互画布")
        assert main_canvas.get_attribute("data-ply-mesh-face-count") == "2"

        page.get_by_role("button", name="加载机器人", exact=True).click()
        page.get_by_role("option", name="加载机器人 botx_abx_zivid_m70").click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )
        page.get_by_role("tab", name="虚拟示教与相机").click()
        panel = page.get_by_label("Zivid 2 M70 相机视图", exact=True)
        panel.scroll_into_view_if_needed()
        page.wait_for_function(
            "document.querySelector('[data-zivid-model=\"zivid-2-m70\"]')?.dataset.rendererStatus === 'ready'"
        )

        canvas = camera_canvas(panel)
        assert panel.get_attribute("data-rgb-surface-mode") == "embedded-mesh+local-surface"
        assert panel.get_attribute("data-render-mode") == "rgb"
        assert canvas.get_attribute("data-rgb-surface-mode") == "embedded-mesh+local-surface"
        assert canvas.get_attribute("data-rgb-mesh-visible") == "true"
        assert canvas.get_attribute("data-source-mesh-face-count") == "2"
        assert canvas.get_attribute("data-camera-mesh-selection") == "camera-global-mesh-lod"
        assert canvas.get_attribute("data-camera-mesh-candidate-face-count") == "2"
        assert canvas.get_attribute("data-render-mesh-face-count") == "2"
        assert canvas.get_attribute("data-rgb-point-layer") == "local-unreferenced-vertices"
        assert canvas.get_attribute("data-rgb-points-depth-policy") == "strictly-in-front-of-mesh"
        assert canvas.get_attribute("data-rgb-surface-selection") == "camera-local-depth-surface"
        assert panel.get_attribute("data-rendered-mesh-face-count") == "2"

        camera_quality = panel.get_by_label("相机网格渲染质量", exact=True)
        assert camera_quality.input_value() == "auto"
        camera_quality.select_option("balanced")
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.meshRenderQuality === 'balanced'"
        )
        page.wait_for_function(
            "document.querySelector('.zivid-camera-canvas')?.dataset.meshRenderQuality === 'balanced'"
        )
        panel = page.get_by_label("Zivid 2 M70 相机视图", exact=True)
        canvas = camera_canvas(panel)
        assert page.get_by_label("网格渲染质量", exact=True).input_value() == "balanced"
        assert canvas.get_attribute("data-rgb-mesh-visible") == "true"

        panel.get_by_role("button", name="点云", exact=True).click()
        page.wait_for_function(
            "document.querySelector('.zivid-camera-canvas')?.dataset.renderMode === 'pointcloud'"
        )
        assert camera_canvas(panel).get_attribute("data-rgb-mesh-visible") == "false"

        panel.get_by_role("button", name="RGB", exact=True).click()
        page.wait_for_function(
            "document.querySelector('.zivid-camera-canvas')?.dataset.rgbMeshVisible === 'true'"
        )
        panel.screenshot(path="/tmp/atlas-zivid-rgb-mesh-quality.png")

        print("rgb_surface_mode=", panel.get_attribute("data-rgb-surface-mode"))
        print("mesh_quality=", main_canvas.get_attribute("data-mesh-render-quality"))
        print("page_errors=", page_errors)
        print("console_errors=", console_errors)
        assert not page_errors
        assert not console_errors
        browser.close()


if __name__ == "__main__":
    run()
