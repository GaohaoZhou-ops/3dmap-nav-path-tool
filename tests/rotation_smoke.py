import os
from pathlib import Path
from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
FIXTURE = Path(__file__).parent / "fixtures" / "rotation-map.ply"


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.set_default_timeout(30_000)
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.goto(BASE_URL)
        page.wait_for_load_state("networkidle")
        page.locator('input[type="file"][accept=".ply"]').set_input_files(str(FIXTURE))
        page.locator(".map-state-dot.online").wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")

        canvas = page.locator(".three-canvas")
        assert canvas.get_attribute("data-control-mode") == "free-trackball"
        assert canvas.get_attribute("data-zoom-mode") == "deep-detail"
        assert canvas.get_attribute("data-coordinate-origin") == "0,0,0"
        assert canvas.get_attribute("data-interaction-mode") == "rotate"
        assert canvas.get_attribute("data-resolution-percent") == "100"
        assert canvas.get_attribute("data-render-point-count") == "24"
        assert canvas.get_attribute("data-color-mode") == "source"
        vector_map = page.get_by_label("二维矢量点云截面")
        assert vector_map.get_attribute("data-render-mode") == "vector-coordinate-webgl"
        assert vector_map.get_attribute("data-source-point-count") == "24"
        assert page.get_by_role("button", name="原点", exact=True).is_visible()
        origin_2d = page.get_by_role("button", name="二维坐标原点")
        assert origin_2d.count() == 1
        assert "is-offscreen" not in (origin_2d.get_attribute("class") or "")

        resolution = page.get_by_role("group", name="点云显示分辨率")
        decrease = page.get_by_role("button", name="降低点云分辨率")
        increase = page.get_by_role("button", name="提高点云分辨率")
        reset = page.get_by_role("button", name="重置点云分辨率")
        assert resolution.is_visible()
        assert "100%" in resolution.inner_text()
        assert increase.is_disabled()
        assert reset.is_disabled()

        color_toggle = page.get_by_role("button", name="按高度渲染点云")
        assert color_toggle.get_attribute("aria-pressed") == "false"
        assert page.get_by_label("点云高程比例尺").count() == 0
        source_color_frame = canvas.screenshot()
        color_toggle.click()
        page.wait_for_timeout(80)
        assert color_toggle.get_attribute("aria-pressed") == "true"
        assert canvas.get_attribute("data-color-mode") == "height"
        elevation_scale = page.get_by_label("点云高程比例尺")
        assert elevation_scale.is_visible()
        assert "4.40" in elevation_scale.inner_text()
        assert "0.00" in elevation_scale.inner_text()
        height_color_frame = canvas.screenshot()
        assert source_color_frame != height_color_frame
        color_toggle.click()
        assert canvas.get_attribute("data-color-mode") == "source"
        assert page.get_by_label("点云高程比例尺").count() == 0

        full_resolution_frame = canvas.screenshot()
        decrease.click()
        assert canvas.get_attribute("data-resolution-percent") == "75"
        assert canvas.get_attribute("data-render-point-count") == "18"
        assert "75%" in resolution.inner_text()

        # Continue to the lowest performance-oriented level. The draw count and
        # rendered frame must both change, while reset restores the source count.
        for _ in range(4):
            decrease.click()
        page.wait_for_timeout(80)
        assert canvas.get_attribute("data-resolution-percent") == "5"
        assert canvas.get_attribute("data-render-point-count") == "1"
        assert decrease.is_disabled()
        performance_frame = canvas.screenshot()
        assert full_resolution_frame != performance_frame

        increase.click()
        assert canvas.get_attribute("data-resolution-percent") == "10"
        assert canvas.get_attribute("data-render-point-count") == "2"
        reset.click()
        assert canvas.get_attribute("data-resolution-percent") == "100"
        assert canvas.get_attribute("data-render-point-count") == "24"
        assert increase.is_disabled()
        assert reset.is_disabled()

        box = canvas.bounding_box()
        assert box
        drag_x = box["x"] + box["width"] * 0.45
        start_y = box["y"] + box["height"] * 0.72
        end_y = box["y"] + box["height"] * 0.28
        previous_frame = canvas.screenshot()
        responsive_rotations = 0

        # Ten large drags rotate through more than one full vertical orbit.
        # Every drag must still alter the rendered frame after crossing both poles.
        for _ in range(10):
            page.mouse.move(drag_x, start_y)
            page.mouse.down()
            page.mouse.move(drag_x, end_y, steps=3)
            page.mouse.up()
            page.wait_for_timeout(60)
            current_frame = canvas.screenshot()
            if current_frame != previous_frame:
                responsive_rotations += 1
            previous_frame = current_frame

        page.screenshot(path="/tmp/atlas-free-rotation.png", full_page=True)
        print("responsive_rotations=", responsive_rotations)
        print("page_errors=", errors)
        assert responsive_rotations == 10

        page.get_by_role("button", name="平移", exact=True).click()
        assert canvas.get_attribute("data-interaction-mode") == "pan"
        before_pan = canvas.screenshot()
        page.mouse.move(
            box["x"] + box["width"] * 0.38,
            box["y"] + box["height"] * 0.52,
        )
        page.mouse.down()
        page.mouse.move(
            box["x"] + box["width"] * 0.62,
            box["y"] + box["height"] * 0.63,
            steps=3,
        )
        page.mouse.up()
        page.wait_for_timeout(80)
        after_pan = canvas.screenshot()
        assert before_pan != after_pan

        # Deep zoom must continue beyond the former radius * 0.015 clamp. A
        # second wheel sequence must still decrease the camera distance.
        page.mouse.move(
            box["x"] + box["width"] * 0.5,
            box["y"] + box["height"] * 0.5,
        )
        initial_distance = float(canvas.get_attribute("data-camera-distance"))
        for _ in range(35):
            page.mouse.wheel(0, -500)
            page.wait_for_timeout(18)
        deep_distance = float(canvas.get_attribute("data-camera-distance"))
        deep_near = float(canvas.get_attribute("data-camera-near"))
        assert deep_distance < initial_distance * 0.01
        assert deep_near < deep_distance * 0.01

        for _ in range(5):
            page.mouse.wheel(0, -500)
            page.wait_for_timeout(18)
        continued_distance = float(canvas.get_attribute("data-camera-distance"))
        assert continued_distance < deep_distance * 0.75
        page.screenshot(path="/tmp/atlas-deep-zoom.png", full_page=True)
        print("zoom_distance=", initial_distance, "->", deep_distance, "->", continued_distance)
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
