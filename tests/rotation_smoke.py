import math
import os
from pathlib import Path
from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
FIXTURE = Path(__file__).parent / "fixtures" / "rotation-map.ply"


def view_direction(camera, target):
    delta = tuple(target[axis] - camera[axis] for axis in ("x", "y", "z"))
    length = math.sqrt(sum(value * value for value in delta))
    assert length > 1e-12
    return tuple(value / length for value in delta)


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
        canvas.focus()
        assert canvas.get_attribute("data-control-mode") == "free-trackball"
        assert canvas.get_attribute("data-zoom-mode") == "hybrid-continuous-detail"
        assert canvas.get_attribute("data-coordinate-origin") == "0,0,0"
        assert canvas.get_attribute("data-coordinate-origin-style") == "ros-rviz"
        assert canvas.get_attribute("data-coordinate-axis-colors") == "x:red,y:green,z:blue"
        assert canvas.get_attribute("data-interaction-mode") == "rotate"
        assert canvas.get_attribute("data-keyboard-plane") == "xy-target-locked"
        assert canvas.get_attribute("data-keyboard-vertical-axis") == "q:+z,e:-z"
        assert canvas.get_attribute("data-keyboard-enabled") == "true"
        assert canvas.get_attribute("data-keyboard-mode") == "always-on"
        assert canvas.get_attribute("data-keyboard-pan-mode") == (
            "world-with-precision-offset"
        )
        assert canvas.get_attribute("data-keyboard-look-mode") == "arrow-orbit-target"
        assert canvas.get_attribute("data-keyboard-look-keys") == (
            "arrowup:pitch-up,arrowdown:pitch-down,"
            "arrowleft:yaw-left,arrowright:yaw-right"
        )
        assert canvas.get_attribute("data-keyboard-yaw-ownership") == (
            "camera-unless-mecanum-control"
        )
        assert canvas.get_attribute("data-keyboard-roll-mode") is None
        assert "I J K L" not in canvas.get_attribute("aria-keyshortcuts")
        assert "Q E" in canvas.get_attribute("aria-keyshortcuts")
        assert "ArrowUp ArrowDown" in canvas.get_attribute("aria-keyshortcuts")
        assert "ArrowLeft ArrowRight" in canvas.get_attribute("aria-keyshortcuts")
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
        assert canvas.get_attribute("data-keyboard-pan-implementation") == "world"

        # Q/E translate camera and target together on world Z. The XY position,
        # orientation target and viewing distance must remain unchanged.
        vertical_camera_before = camera_after
        vertical_target_before = target_after
        vertical_distance_before = distance_after
        page.keyboard.press("q")
        page.wait_for_timeout(100)
        vertical_up_camera = {
            axis: float(canvas.get_attribute(f"data-camera-{axis}"))
            for axis in ("x", "y", "z")
        }
        vertical_up_target = {
            axis: float(canvas.get_attribute(f"data-target-{axis}"))
            for axis in ("x", "y", "z")
        }
        assert canvas.get_attribute("data-last-keyboard-key") == "Q"
        assert canvas.get_attribute("data-last-keyboard-vertical") == "z-up"
        assert vertical_up_camera["z"] > vertical_camera_before["z"] + 0.01
        assert vertical_up_target["z"] > vertical_target_before["z"] + 0.01
        for axis in ("x", "y"):
            assert abs(vertical_up_camera[axis] - vertical_camera_before[axis]) < 1e-9
            assert abs(vertical_up_target[axis] - vertical_target_before[axis]) < 1e-9
        assert abs(
            (vertical_up_camera["z"] - vertical_camera_before["z"])
            - (vertical_up_target["z"] - vertical_target_before["z"])
        ) < 1e-6
        assert abs(
            float(canvas.get_attribute("data-camera-distance")) - vertical_distance_before
        ) < 1e-6

        page.keyboard.press("e")
        page.wait_for_timeout(100)
        camera_after = {
            axis: float(canvas.get_attribute(f"data-camera-{axis}"))
            for axis in ("x", "y", "z")
        }
        target_after = {
            axis: float(canvas.get_attribute(f"data-target-{axis}"))
            for axis in ("x", "y", "z")
        }
        distance_after = float(canvas.get_attribute("data-camera-distance"))
        assert canvas.get_attribute("data-last-keyboard-key") == "E"
        assert canvas.get_attribute("data-last-keyboard-vertical") == "z-down"
        assert camera_after["z"] < vertical_up_camera["z"] - 0.01
        assert target_after["z"] < vertical_up_target["z"] - 0.01
        for axis in ("x", "y"):
            assert abs(camera_after[axis] - vertical_up_camera[axis]) < 1e-9
            assert abs(target_after[axis] - vertical_up_target[axis]) < 1e-9
        assert abs(distance_after - vertical_distance_before) < 1e-6

        # ArrowLeft/ArrowRight yaw around world Z, while ArrowUp/ArrowDown
        # pitch around the camera-local right axis. All four controls orbit the
        # current target without changing it or the viewing distance.
        look_camera = camera_after
        look_target = target_after
        look_distance = distance_after
        look_before = view_direction(look_camera, look_target)

        page.keyboard.press("ArrowLeft")
        page.wait_for_timeout(100)
        yaw_left_camera = {
            axis: float(canvas.get_attribute(f"data-camera-{axis}"))
            for axis in ("x", "y", "z")
        }
        yaw_left_target = {
            axis: float(canvas.get_attribute(f"data-target-{axis}"))
            for axis in ("x", "y", "z")
        }
        yaw_left = view_direction(yaw_left_camera, yaw_left_target)
        assert canvas.get_attribute("data-last-keyboard-key") == "ArrowLeft"
        assert canvas.get_attribute("data-last-keyboard-rotation") == "yaw-left"
        assert look_before[0] * yaw_left[1] - look_before[1] * yaw_left[0] > 0.01
        assert abs(yaw_left[2] - look_before[2]) < 1e-6
        assert yaw_left_target == look_target
        assert abs(float(canvas.get_attribute("data-camera-distance")) - look_distance) < 1e-6

        page.keyboard.press("ArrowRight")
        page.wait_for_timeout(100)
        yaw_right_camera = {
            axis: float(canvas.get_attribute(f"data-camera-{axis}"))
            for axis in ("x", "y", "z")
        }
        yaw_right_target = {
            axis: float(canvas.get_attribute(f"data-target-{axis}"))
            for axis in ("x", "y", "z")
        }
        yaw_right = view_direction(yaw_right_camera, yaw_right_target)
        assert canvas.get_attribute("data-last-keyboard-rotation") == "yaw-right"
        assert yaw_left[0] * yaw_right[1] - yaw_left[1] * yaw_right[0] < -0.01
        assert yaw_right_target == look_target

        page.keyboard.press("ArrowUp")
        page.wait_for_timeout(100)
        pitch_up_camera = {
            axis: float(canvas.get_attribute(f"data-camera-{axis}"))
            for axis in ("x", "y", "z")
        }
        pitch_up_target = {
            axis: float(canvas.get_attribute(f"data-target-{axis}"))
            for axis in ("x", "y", "z")
        }
        pitch_up = view_direction(pitch_up_camera, pitch_up_target)
        assert canvas.get_attribute("data-last-keyboard-rotation") == "pitch-up"
        assert pitch_up[2] > yaw_right[2] + 0.01
        assert pitch_up_target == look_target

        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(100)
        pitch_down_camera = {
            axis: float(canvas.get_attribute(f"data-camera-{axis}"))
            for axis in ("x", "y", "z")
        }
        pitch_down_target = {
            axis: float(canvas.get_attribute(f"data-target-{axis}"))
            for axis in ("x", "y", "z")
        }
        pitch_down = view_direction(pitch_down_camera, pitch_down_target)
        assert canvas.get_attribute("data-last-keyboard-rotation") == "pitch-down"
        assert pitch_down[2] < pitch_up[2] - 0.01
        assert pitch_down_target == look_target
        assert abs(float(canvas.get_attribute("data-camera-distance")) - look_distance) < 1e-6

        # I/J/K/L are no longer application shortcuts and must not affect the view.
        removed_keys_view = {
            key: float(canvas.get_attribute(f"data-{key}"))
            for key in (
                "camera-x",
                "camera-y",
                "camera-z",
                "camera-up-x",
                "camera-up-y",
                "camera-up-z",
                "target-x",
                "target-y",
                "target-z",
            )
        }
        removed_keys_input_count = int(
            canvas.get_attribute("data-keyboard-input-count") or 0
        )
        for key in ("i", "j", "k", "l"):
            page.keyboard.press(key)
        page.wait_for_timeout(100)
        assert {
            key: float(canvas.get_attribute(f"data-{key}"))
            for key in removed_keys_view
        } == removed_keys_view
        assert int(canvas.get_attribute("data-keyboard-input-count") or 0) == (
            removed_keys_input_count
        )

        # Numeric/text editing must retain normal keyboard ownership and must
        # never steer the 3D camera in the background.
        height_input = page.get_by_label("截面中心高度数值")
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
        edit_camera_before = {
            key: float(canvas.get_attribute(f"data-{key}"))
            for key in (
                "camera-x",
                "camera-y",
                "camera-z",
                "camera-up-x",
                "camera-up-y",
                "camera-up-z",
            )
        }
        page.keyboard.press("j")
        page.wait_for_timeout(100)
        edit_camera_after = {
            key: float(canvas.get_attribute(f"data-{key}"))
            for key in edit_camera_before
        }
        assert edit_camera_after == edit_camera_before
        page.keyboard.press("q")
        page.wait_for_timeout(100)
        assert {
            key: float(canvas.get_attribute(f"data-{key}"))
            for key in edit_camera_before
        } == edit_camera_before
        page.keyboard.press("ArrowLeft")
        page.wait_for_timeout(100)
        edit_roll_after = {
            key: float(canvas.get_attribute(f"data-{key}"))
            for key in edit_camera_before
        }
        assert edit_roll_after == edit_camera_before
        edit_vertical_before = {
            key: float(canvas.get_attribute(f"data-{key}"))
            for key in (
                "camera-x",
                "camera-y",
                "camera-z",
                "target-x",
                "target-y",
                "target-z",
            )
        }
        original_height_value = height_input.input_value()
        page.keyboard.press("ArrowUp")
        page.wait_for_timeout(100)
        edit_vertical_after = {
            key: float(canvas.get_attribute(f"data-{key}"))
            for key in edit_vertical_before
        }
        assert edit_vertical_after == edit_vertical_before
        height_input.fill(original_height_value)
        height_input.blur()
        page.screenshot(path="/tmp/atlas-keyboard-navigation.png", full_page=True)
        page.get_by_role("button", name="原点", exact=True).click()
        page.wait_for_timeout(120)
        overview_axis_scale = float(canvas.get_attribute("data-coordinate-axis-scale"))
        assert 20 <= float(canvas.get_attribute("data-coordinate-axis-screen-length")) <= 68.1
        page.screenshot(path="/tmp/atlas-ros-origin.png", full_page=True)

        # Pointer capture must be cancelled as soon as a held drag crosses the
        # 3D canvas boundary. Returning without a new pointerdown must not keep
        # rotating the cloud.
        leave_box = canvas.bounding_box()
        assert leave_box
        page.mouse.move(
            leave_box["x"] + leave_box["width"] * 0.52,
            leave_box["y"] + leave_box["height"] * 0.52,
        )
        page.mouse.down()
        page.mouse.move(
            leave_box["x"] + leave_box["width"] * 0.7,
            leave_box["y"] + leave_box["height"] * 0.4,
            steps=3,
        )
        page.mouse.move(
            leave_box["x"] + leave_box["width"] + 24,
            leave_box["y"] + leave_box["height"] * 0.4,
            steps=2,
        )
        page.wait_for_timeout(80)
        assert canvas.get_attribute("data-pointer-gesture-state") == "cancelled-on-leave"
        assert int(canvas.get_attribute("data-pointer-gesture-cancel-count")) >= 1
        frozen_view = {
            key: float(canvas.get_attribute(f"data-{key}"))
            for key in (
                "camera-x",
                "camera-y",
                "camera-z",
                "camera-up-x",
                "camera-up-y",
                "camera-up-z",
                "target-x",
                "target-y",
                "target-z",
            )
        }
        page.mouse.up()
        page.mouse.move(
            leave_box["x"] + leave_box["width"] * 0.35,
            leave_box["y"] + leave_box["height"] * 0.65,
            steps=4,
        )
        page.mouse.move(
            leave_box["x"] + leave_box["width"] * 0.68,
            leave_box["y"] + leave_box["height"] * 0.3,
            steps=4,
        )
        page.wait_for_timeout(100)
        returned_view = {
            key: float(canvas.get_attribute(f"data-{key}"))
            for key in frozen_view
        }
        for key, expected in frozen_view.items():
            assert abs(returned_view[key] - expected) < 1e-8

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
        rotate_mode_button = page.locator(".viewer-tool-switch button").nth(0)
        pan_mode_button = page.locator(".viewer-tool-switch button").nth(1)
        page.keyboard.down("Shift")
        page.wait_for_timeout(30)
        assert canvas.get_attribute("data-shift-pan-armed") == "true"
        assert canvas.get_attribute("data-effective-interaction-mode") == "shift-pan"
        assert rotate_mode_button.get_attribute("aria-pressed") == "false"
        assert pan_mode_button.get_attribute("aria-pressed") == "true"
        assert "Shift 平移" in pan_mode_button.inner_text()
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
        assert canvas.get_attribute("data-shift-pan-armed") == "false"
        assert canvas.get_attribute("data-effective-interaction-mode") == "rotate"
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

        # Shift must also promote an already-held rotate drag to precision pan.
        # This covers users who press the modifier just after pointerdown.
        late_shift_target_before = {
            axis: float(canvas.get_attribute(f"data-target-{axis}"))
            for axis in ("x", "y", "z")
        }
        late_shift_camera_before = {
            axis: float(canvas.get_attribute(f"data-camera-{axis}"))
            for axis in ("x", "y", "z")
        }
        page.mouse.move(
            shift_box["x"] + shift_box["width"] * 0.46,
            shift_box["y"] + shift_box["height"] * 0.48,
        )
        page.mouse.down()
        page.keyboard.down("Shift")
        page.wait_for_timeout(30)
        assert canvas.get_attribute("data-last-pointer-gesture") == "shift-pan"
        assert int(canvas.get_attribute("data-shift-pan-activation-count")) >= 1
        page.mouse.move(
            shift_box["x"] + shift_box["width"] * 0.58,
            shift_box["y"] + shift_box["height"] * 0.61,
            steps=4,
        )
        page.screenshot(path="/tmp/atlas-shift-pan-active.png", full_page=True)
        page.mouse.up()
        page.keyboard.up("Shift")
        page.wait_for_timeout(80)
        late_shift_target_after = {
            axis: float(canvas.get_attribute(f"data-target-{axis}"))
            for axis in ("x", "y", "z")
        }
        late_shift_camera_after = {
            axis: float(canvas.get_attribute(f"data-camera-{axis}"))
            for axis in ("x", "y", "z")
        }
        assert math.hypot(
            late_shift_target_after["x"] - late_shift_target_before["x"],
            late_shift_target_after["y"] - late_shift_target_before["y"],
        ) > 0.01
        for axis in ("x", "y", "z"):
            assert abs(
                (late_shift_camera_after[axis] - late_shift_camera_before[axis])
                - (late_shift_target_after[axis] - late_shift_target_before[axis])
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

        # The first optical-zoom decade used to be a dead zone: movement was
        # smaller than float32 GPU matrix precision, but the old fallback did
        # not activate until 32x. Enter that exact transition range and verify
        # that wheel interaction also takes keyboard focus back from an input.
        height_input.focus()
        assert page.evaluate(
            "document.activeElement === document.querySelector('[aria-label=\"截面中心高度数值\"]')"
        )
        transition_zoom = 1.0
        for _ in range(50):
            page.mouse.move(
                box["x"] + box["width"] * 0.5,
                box["y"] + box["height"] * 0.5,
            )
            page.mouse.wheel(0, -500)
            page.wait_for_timeout(10)
            transition_zoom = float(canvas.get_attribute("data-optical-zoom"))
            if 1.05 < transition_zoom < 30:
                break
        assert 1.05 < transition_zoom < 30
        assert page.evaluate(
            "document.activeElement === document.querySelector('.three-canvas')"
        )
        assert canvas.get_attribute("data-keyboard-focus-source") == "wheel"
        assert canvas.get_attribute("data-keyboard-detail-speed") == (
            "constant-screen-space"
        )
        for key in ("w", "a", "q", "e"):
            transition_x_before = float(canvas.get_attribute("data-precision-pan-x"))
            transition_y_before = float(canvas.get_attribute("data-precision-pan-y"))
            page.keyboard.press(key)
            page.wait_for_timeout(55)
            transition_x_after = float(canvas.get_attribute("data-precision-pan-x"))
            transition_y_after = float(canvas.get_attribute("data-precision-pan-y"))
            assert math.hypot(
                transition_x_after - transition_x_before,
                transition_y_after - transition_y_before,
            ) >= 4
            if key in ("q", "e"):
                assert canvas.get_attribute(
                    "data-keyboard-vertical-implementation"
                ) == "precision-offset"
            else:
                assert canvas.get_attribute(
                    "data-keyboard-pan-implementation"
                ) == "precision-offset"

        page.get_by_role("button", name="重置3D视角").click()
        page.get_by_role("button", name="原点", exact=True).click()
        page.wait_for_timeout(80)

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

        # WASD must remain visibly responsive after world-coordinate movement
        # falls below render-matrix precision. Every direction uses the same
        # persistent pixel-offset mechanism as microscopic mouse panning.
        keyboard_precision_count = int(
            canvas.get_attribute("data-keyboard-precision-movement-count") or 0
        )
        for key in ("w", "a", "s", "d", "q", "e"):
            keyboard_x_before = float(canvas.get_attribute("data-precision-pan-x"))
            keyboard_y_before = float(canvas.get_attribute("data-precision-pan-y"))
            page.keyboard.press(key)
            page.wait_for_timeout(70)
            keyboard_x_after = float(canvas.get_attribute("data-precision-pan-x"))
            keyboard_y_after = float(canvas.get_attribute("data-precision-pan-y"))
            if key in ("q", "e"):
                assert canvas.get_attribute(
                    "data-keyboard-vertical-implementation"
                ) == "precision-offset"
            else:
                assert canvas.get_attribute("data-keyboard-pan-implementation") == (
                    "precision-offset"
                )
            assert math.hypot(
                keyboard_x_after - keyboard_x_before,
                keyboard_y_after - keyboard_y_before,
            ) >= 4
            assert float(canvas.get_attribute("data-keyboard-precision-pixels")) >= 4

        assert int(
            canvas.get_attribute("data-keyboard-precision-movement-count")
        ) >= keyboard_precision_count + 6

        # Holding a key should accumulate immediately at a stable screen-space
        # rate instead of waiting seconds for world-coordinate rounding.
        hold_x_before = float(canvas.get_attribute("data-precision-pan-x"))
        hold_y_before = float(canvas.get_attribute("data-precision-pan-y"))
        page.keyboard.down("d")
        page.wait_for_timeout(320)
        page.keyboard.up("d")
        page.wait_for_timeout(35)
        hold_x_after = float(canvas.get_attribute("data-precision-pan-x"))
        hold_y_after = float(canvas.get_attribute("data-precision-pan-y"))
        assert math.hypot(
            hold_x_after - hold_x_before,
            hold_y_after - hold_y_before,
        ) >= 35
        page.screenshot(path="/tmp/atlas-keyboard-deep-zoom.png", full_page=True)

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
