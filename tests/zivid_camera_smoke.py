import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
ROOT = Path(__file__).resolve().parents[1]


def vector_attribute(locator, name):
    return tuple(float(value) for value in locator.get_attribute(name).split(","))


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(180_000)
        page.on("pageerror", lambda error: errors.append(str(error)))

        page.goto(BASE_URL, wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        assert page.get_by_label("Zivid 2 M70 相机视图").count() == 0

        page.locator('input[type="file"][accept=".ply"]').set_input_files(
            str(ROOT / "tests/fixtures/rotation-map.ply")
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.get_by_role("button", name="加载机器人", exact=True).click()
        page.get_by_role("option", name="加载机器人 botx_abx_zivid_m70").click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )

        main_canvas = page.locator(".three-canvas")
        teaching_tab = page.get_by_role("tab", name="虚拟示教与相机")
        teaching_tab.click()
        assert teaching_tab.get_attribute("aria-selected") == "true"
        page.get_by_role("button", name="隐藏全关节浮动窗口").click()
        panel = page.get_by_label("Zivid 2 M70 相机视图")
        panel.scroll_into_view_if_needed()
        panel.wait_for()
        assert panel.get_attribute("data-zivid-model") == "zivid-2-m70"
        assert panel.get_attribute("data-horizontal-fov") == "56.6"
        assert panel.get_attribute("data-vertical-fov") == "35.6"
        assert panel.get_attribute("data-working-near") == "0.3"
        assert panel.get_attribute("data-working-far") == "1.3"
        assert panel.get_attribute("data-native-resolution") == "1944x1200"
        assert panel.get_attribute("data-optical-frame") == "zivid_left_optical_frame"
        page.wait_for_function(
            "document.querySelector('[data-zivid-model=\"zivid-2-m70\"]')?.dataset.rendererStatus === 'ready'"
        )
        camera_canvas = panel.locator(".zivid-camera-canvas")
        assert camera_canvas.get_attribute("data-camera-ready") == "true"
        assert camera_canvas.get_attribute("data-render-mode") == "rgb"
        assert int(camera_canvas.get_attribute("data-render-point-count")) > 0

        panel.get_by_role("button", name="点云", exact=True).click()
        page.wait_for_function(
            "document.querySelector('[data-zivid-model=\"zivid-2-m70\"]')?.dataset.renderMode === 'pointcloud'"
        )
        assert camera_canvas.get_attribute("data-render-mode") == "pointcloud"
        assert panel.get_by_label("点云深度色标").is_visible()

        panel.get_by_role("button", name="放大相机画面").click()
        panel.get_by_role("button", name="放大相机画面").click()
        page.wait_for_function(
            "Number(document.querySelector('[data-zivid-model=\"zivid-2-m70\"]')?.dataset.zoom) > 2"
        )
        assert float(camera_canvas.get_attribute("data-digital-zoom")) > 2

        panel.get_by_role("button", name="右臂 M70").click()
        page.wait_for_function(
            "document.querySelector('[data-zivid-model=\"zivid-2-m70\"]')?.dataset.opticalFrame === 'zivid_right_optical_frame'"
        )
        panel = page.get_by_label("Zivid 2 M70 相机视图")
        assert panel.get_attribute("data-camera-side") == "right"
        assert panel.get_attribute("data-zoom") == "1.00"

        before_position = vector_attribute(main_canvas, "data-zivid-right-optical-position")
        before_revision = int(main_canvas.get_attribute("data-zivid-camera-pose-revision"))
        page.get_by_role("button", name="定位机器人模型").click()
        page.keyboard.press("w")
        page.wait_for_function(
            "([revision]) => Number(document.querySelector('.three-canvas')?.dataset.zividCameraPoseRevision) > revision",
            arg=[before_revision],
        )
        after_position = vector_attribute(main_canvas, "data-zivid-right-optical-position")
        assert any(abs(after - before) > 0.02 for after, before in zip(after_position, before_position))

        page.get_by_role("button", name="放大 Zivid 相机视图").click()
        dialog = page.get_by_role("dialog", name="Zivid 2 M70 相机大图")
        dialog.wait_for()
        expanded_panel = dialog.get_by_label("Zivid 2 M70 相机视图")
        assert expanded_panel.is_visible()
        assert expanded_panel.locator(".zivid-camera-canvas").is_visible()
        page.screenshot(path="/tmp/atlas-zivid-m70-camera.png", full_page=True)
        expanded_panel.get_by_role("button", name="关闭 Zivid 相机大图").click()
        dialog.wait_for(state="detached")

        assert not errors, errors
        browser.close()


if __name__ == "__main__":
    run()
