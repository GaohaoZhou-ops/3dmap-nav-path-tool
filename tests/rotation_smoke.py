import math
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
        assert canvas.get_attribute("data-zoom-mode") == "hybrid-continuous-detail"
        assert canvas.get_attribute("data-coordinate-origin") == "0,0,0"
        assert canvas.get_attribute("data-coordinate-origin-style") == "ros-rviz"
        assert canvas.get_attribute("data-coordinate-axis-colors") == "x:red,y:green,z:blue"
        assert canvas.get_attribute("data-interaction-mode") == "rotate"
        assert canvas.get_attribute("data-keyboard-plane") == "xy-z-locked"
        assert canvas.get_attribute("data-keyboard-enabled") == "true"
        assert canvas.get_attribute("data-keyboard-mode") == "always-on"
        assert canvas.get_attribute("data-resolution-percent") == "100"
        assert canvas.get_attribute("data-render-point-count") == "24"
        assert canvas.get_attribute("data-resolution-selection") == "native"
        assert canvas.get_attribute("data-auto-point-budget") == "1000000"
        assert canvas.get_attribute("data-color-mode") == "height"
        vector_map = page.get_by_label("二维矢量点云截面")
        assert vector_map.get_attribute("data-render-mode") == "vector-coordinate-webgl"
        assert vector_map.get_attribute("data-source-point-count") == "24"
        assert vector_map.get_attribute("data-color-mode") == "height"
        assert page.get_by_role("button", name="原点", exact=True).is_visible()
        waypoint_visibility = page.get_by_role("button", name="隐藏3D路径点")
        assert waypoint_visibility.is_visible()
        assert waypoint_visibility.get_attribute("aria-pressed") == "true"
        assert canvas.get_attribute("data-waypoints-visible") == "true"
        assert canvas.get_attribute("data-waypoint-volume-ratio") == "0.2"
        assert abs(float(canvas.get_attribute("data-waypoint-radius-scale")) - 0.584804) < 1e-6
        origin_2d = page.get_by_role("button", name="二维坐标原点")
        assert origin_2d.count() == 1
        assert "is-offscreen" not in (origin_2d.get_attribute("class") or "")
        assert page.locator(".map2d-view").get_attribute("data-coordinate-origin-style") == "ros-rviz"

        assert page.get_by_role("button", name="键盘", exact=True).count() == 0
        camera_before = {
            axis: float(canvas.get_attribute(f"data-camera-{axis}"))
            for axis in ("x", "y", "z")
        }
        target_before = {
            axis: float(canvas.get_attribute(f"data-target-{axis}"))
            for axis in ("x", "y", "z")
        }
        distance_before = float(canvas.get_attribute("data-camera-distance"))
        # A quick tap must produce a deterministic movement impulse even when
        # keydown and keyup happen between two animation frames. Keyboard travel
        # is always available while the mouse remains in its default rotate mode.
        page.keyboard.press("w")
        page.wait_for_timeout(100)
        assert canvas.get_attribute("data-interaction-mode") == "rotate"
        assert canvas.get_attribute("data-last-keyboard-key") == "W"
        assert canvas.get_attribute("data-keyboard-input-count") == "1"
        camera_after = {
            axis: float(canvas.get_attribute(f"data-camera-{axis}"))
            for axis in ("x", "y", "z")
        }
        target_after = {
            axis: float(canvas.get_attribute(f"data-target-{axis}"))
            for axis in ("x", "y", "z")
        }
        distance_after = float(canvas.get_attribute("data-camera-distance"))
        camera_xy_shift = (
            (camera_after["x"] - camera_before["x"]) ** 2
            + (camera_after["y"] - camera_before["y"]) ** 2
        ) ** 0.5
        assert camera_xy_shift > 0.01
        assert abs(camera_after["z"] - camera_before["z"]) < 1e-9
        assert abs(target_after["z"] - target_before["z"]) < 1e-9
        assert abs(distance_after - distance_before) < 1e-6
        assert abs(
            (camera_after["x"] - camera_before["x"])
            - (target_after["x"] - target_before["x"])
        ) < 1e-6
        assert abs(
            (camera_after["y"] - camera_before["y"])
            - (target_after["y"] - target_before["y"])
        ) < 1e-6

        # Numeric/text editing must retain normal keyboard ownership and must
        # never steer the 3D camera in the background.
        height_input = page.get_by_label("高度", exact=True)
        height_input.focus()
        edit_target_before = {
            axis: float(canvas.get_attribute(f"data-target-{axis}"))
            for axis in ("x", "y", "z")
        }
        page.keyboard.press("w")
        page.wait_for_timeout(100)
        edit_target_after = {
            axis: float(canvas.get_attribute(f"data-target-{axis}"))
            for axis in ("x", "y", "z")
        }
        assert edit_target_after == edit_target_before
        height_input.blur()
        page.screenshot(path="/tmp/atlas-keyboard-navigation.png", full_page=True)
        page.get_by_role("button", name="原点", exact=True).click()
        page.wait_for_timeout(120)
        overview_axis_scale = float(canvas.get_attribute("data-coordinate-axis-scale"))
        assert 20 <= float(canvas.get_attribute("data-coordinate-axis-screen-length")) <= 68.1
        page.screenshot(path="/tmp/atlas-ros-origin.png", full_page=True)

        # In rotate mode, Shift + left drag is a temporary pan gesture. It must
        # translate camera and target together without changing the active mode.
        shift_box = canvas.bounding_box()
        assert shift_box
        shift_target_before = {
            axis: float(canvas.get_attribute(f"data-target-{axis}"))
            for axis in ("x", "y", "z")
        }
        shift_camera_before = {
            axis: float(canvas.get_attribute(f"data-camera-{axis}"))
            for axis in ("x", "y", "z")
        }
        page.keyboard.down("Shift")
        page.mouse.move(
            shift_box["x"] + shift_box["width"] * 0.43,
            shift_box["y"] + shift_box["height"] * 0.47,
        )
        page.mouse.down()
        page.mouse.move(
            shift_box["x"] + shift_box["width"] * 0.61,
            shift_box["y"] + shift_box["height"] * 0.58,
            steps=4,
        )
        page.mouse.up()
        page.keyboard.up("Shift")
        page.wait_for_timeout(80)
        shift_target_after = {
            axis: float(canvas.get_attribute(f"data-target-{axis}"))
            for axis in ("x", "y", "z")
        }
        shift_camera_after = {
            axis: float(canvas.get_attribute(f"data-camera-{axis}"))
            for axis in ("x", "y", "z")
        }
        assert canvas.get_attribute("data-interaction-mode") == "rotate"
        assert canvas.get_attribute("data-last-pointer-gesture") == "shift-pan"
        assert math.hypot(
            shift_target_after["x"] - shift_target_before["x"],
            shift_target_after["y"] - shift_target_before["y"],
        ) > 0.01
        for axis in ("x", "y", "z"):
            assert abs(
                (shift_camera_after[axis] - shift_camera_before[axis])
                - (shift_target_after[axis] - shift_target_before[axis])
            ) < 1e-6

        resolution = page.get_by_role("group", name="点云显示分辨率")
        decrease = page.get_by_role("button", name="降低点云分辨率")
        increase = page.get_by_role("button", name="提高点云分辨率")
        reset = page.get_by_role("button", name="重置点云分辨率")
        assert resolution.is_visible()
        assert "100%" in resolution.inner_text()
        assert increase.is_disabled()
        assert reset.is_disabled()

        color_toggle = page.get_by_role("button", name="切换点云颜色模式")
        assert color_toggle.get_attribute("data-color-mode") == "height"
        elevation_scale = page.get_by_label("点云高程比例尺")
        assert elevation_scale.is_visible()
        assert "4.40" in elevation_scale.inner_text()
        assert "0.00" in elevation_scale.inner_text()
        height_color_frame = canvas.screenshot()

        # One shared tri-state cycle drives both the 3D and vector 2D clouds:
        # height -> source -> white -> height.
        color_toggle.click()
        page.wait_for_timeout(80)
        assert color_toggle.get_attribute("data-color-mode") == "source"
        assert canvas.get_attribute("data-color-mode") == "source"
        assert vector_map.get_attribute("data-color-mode") == "source"
        assert page.get_by_label("点云高程比例尺").count() == 0
        source_color_frame = canvas.screenshot()
        assert source_color_frame != height_color_frame

        color_toggle.click()
        page.wait_for_timeout(80)
        assert color_toggle.get_attribute("data-color-mode") == "white"
        assert canvas.get_attribute("data-color-mode") == "white"
        assert vector_map.get_attribute("data-color-mode") == "white"
        assert page.get_by_label("点云高程比例尺").count() == 0
        white_color_frame = canvas.screenshot()
        assert white_color_frame != source_color_frame
        page.screenshot(path="/tmp/atlas-white-color.png", full_page=True)

        color_toggle.click()
        assert color_toggle.get_attribute("data-color-mode") == "height"
        assert canvas.get_attribute("data-color-mode") == "height"
        assert vector_map.get_attribute("data-color-mode") == "height"
        assert page.get_by_label("点云高程比例尺").is_visible()

        full_resolution_frame = canvas.screenshot()
        decrease.click()
        assert canvas.get_attribute("data-resolution-percent") == "75"
        assert canvas.get_attribute("data-render-point-count") == "18"
        assert canvas.get_attribute("data-resolution-selection") == "manual"
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
        pan_target_before = {
            axis: float(canvas.get_attribute(f"data-target-{axis}"))
            for axis in ("x", "y", "z")
        }
        page.keyboard.press("d")
        page.wait_for_timeout(100)
        pan_target_after = {
            axis: float(canvas.get_attribute(f"data-target-{axis}"))
            for axis in ("x", "y", "z")
        }
        pan_keyboard_shift = (
            (pan_target_after["x"] - pan_target_before["x"]) ** 2
            + (pan_target_after["y"] - pan_target_before["y"]) ** 2
        ) ** 0.5
        assert pan_keyboard_shift > 0.01
        assert abs(pan_target_after["z"] - pan_target_before["z"]) < 1e-9
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

        page.get_by_role("button", name="原点", exact=True).click()
        page.wait_for_timeout(80)
        axis_scale_before_deep_zoom = float(
            canvas.get_attribute("data-coordinate-axis-scale")
        )

        # Deep zoom must continue beyond the former radius * 0.015 clamp. A
        # second wheel sequence must still decrease the camera distance.
        page.mouse.move(
            box["x"] + box["width"] * 0.5,
            box["y"] + box["height"] * 0.5,
        )
        initial_distance = float(canvas.get_attribute("data-effective-camera-distance"))
        for _ in range(35):
            page.mouse.wheel(0, -500)
            page.wait_for_timeout(18)
        deep_distance = float(canvas.get_attribute("data-effective-camera-distance"))
        physical_distance = float(canvas.get_attribute("data-camera-distance"))
        deep_near = float(canvas.get_attribute("data-camera-near"))
        assert deep_distance < initial_distance * 0.01
        assert deep_near < physical_distance * 0.01
        assert canvas.get_attribute("data-zoom-stage") == "optical"
        assert float(canvas.get_attribute("data-optical-zoom")) > 1

        for _ in range(5):
            page.mouse.wheel(0, -500)
            page.wait_for_timeout(18)
        continued_distance = float(canvas.get_attribute("data-effective-camera-distance"))
        assert continued_distance < deep_distance * 0.75
        for _ in range(20):
            page.mouse.wheel(0, -500)
            page.wait_for_timeout(6)
        extreme_distance = float(canvas.get_attribute("data-effective-camera-distance"))
        assert extreme_distance < continued_distance * 1e-6
        assert float(canvas.get_attribute("data-optical-zoom")) > 1e6
        extreme_axis_scale = float(canvas.get_attribute("data-coordinate-axis-scale"))
        extreme_axis_length = float(
            canvas.get_attribute("data-coordinate-axis-screen-length")
        )
        assert extreme_axis_scale < min(overview_axis_scale, axis_scale_before_deep_zoom) * 1e-3
        assert 62 <= extreme_axis_length <= 68.1

        # At microscopic optical zoom, panning switches to a pixel-based view
        # offset and must keep responding instead of rounding down to zero.
        precision_x_before = float(canvas.get_attribute("data-precision-pan-x"))
        precision_y_before = float(canvas.get_attribute("data-precision-pan-y"))
        movement_count_before = int(canvas.get_attribute("data-pan-movement-count") or 0)
        page.mouse.move(
            box["x"] + box["width"] * 0.42,
            box["y"] + box["height"] * 0.48,
        )
        page.mouse.down()
        page.mouse.move(
            box["x"] + box["width"] * 0.68,
            box["y"] + box["height"] * 0.64,
            steps=6,
        )
        page.mouse.up()
        page.wait_for_timeout(40)
        precision_x_after = float(canvas.get_attribute("data-precision-pan-x"))
        precision_y_after = float(canvas.get_attribute("data-precision-pan-y"))
        assert canvas.get_attribute("data-pan-implementation") == "precision-offset"
        assert int(canvas.get_attribute("data-pan-movement-count")) > movement_count_before
        assert math.hypot(
            precision_x_after - precision_x_before,
            precision_y_after - precision_y_before,
        ) > 50

        page.mouse.wheel(0, 500)
        page.wait_for_timeout(30)
        zoomed_out_distance = float(canvas.get_attribute("data-effective-camera-distance"))
        assert zoomed_out_distance > extreme_distance
        page.screenshot(path="/tmp/atlas-deep-zoom.png", full_page=True)
        print(
            "effective_zoom_distance=",
            initial_distance,
            "->",
            deep_distance,
            "->",
            continued_distance,
            "->",
            extreme_distance,
            "->",
            zoomed_out_distance,
        )
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
