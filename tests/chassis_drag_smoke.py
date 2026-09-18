import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:22052")
ROOT = Path(__file__).resolve().parents[1]


def read_pose(canvas):
    return {
        name: float(canvas.get_attribute(f"data-robot-{name}"))
        for name in ("x", "y", "z", "roll", "pitch", "yaw")
    }


def read_camera(canvas):
    return tuple(
        float(canvas.get_attribute(f"data-{name}"))
        for name in (
            "camera-x",
            "camera-y",
            "camera-z",
            "target-x",
            "target-y",
            "target-z",
            "camera-up-x",
            "camera-up-y",
            "camera-up-z",
        )
    )


def chassis_screen_point(canvas):
    box = canvas.bounding_box()
    assert box
    return (
        box["x"] + float(canvas.get_attribute("data-robot-chassis-screen-x")),
        box["y"] + float(canvas.get_attribute("data-robot-chassis-screen-y")),
    )


def assert_fixed_pose(before, after):
    for name in ("z", "roll", "pitch", "yaw"):
        assert abs(after[name] - before[name]) < 1e-7, (name, before[name], after[name])


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(180_000)
        page.on("pageerror", lambda error: errors.append(str(error)))

        page.goto(f"{BASE_URL.rstrip('/')}/workbench", wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator('input[type="file"][accept=".ply"]').set_input_files(
            str(ROOT / "tests/fixtures/rotation-map.ply")
        )
        page.locator(".loading-curtain").wait_for(state="hidden")

        page.get_by_role("button", name="加载机器人", exact=True).click()
        page.get_by_role("option", name="加载机器人 botx_abx_zivid_m70").click()
        canvas = page.locator(".three-canvas")
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )
        assert canvas.get_attribute("data-chassis-drag-handle-ready") == "true"
        assert canvas.get_attribute("data-chassis-drag-target-frame") == "base_link"

        robot_button = page.get_by_role("button", name="定位机器人模型")
        robot_button.click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotControlEnabled === 'true'"
        )
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotChassisScreenVisible === 'true'"
        )
        page.wait_for_timeout(250)

        before = read_pose(canvas)
        camera_before = read_camera(canvas)
        chassis_x, chassis_y = chassis_screen_point(canvas)
        page.mouse.dblclick(chassis_x, chassis_y, delay=70)
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.chassisDragMode === 'armed'"
        )
        assert canvas.get_attribute("data-robot-control-enabled") == "false"
        assert robot_button.get_attribute("aria-pressed") == "false"
        assert "CHASSIS · XY PLANE DRAG" in page.get_by_label("机器人模型状态").inner_text()
        assert "按住底盘拖拽" in page.locator(".viewer-help").inner_text()
        page.screenshot(path="/tmp/atlas-chassis-plane-drag-armed.png", full_page=True)

        chassis_x, chassis_y = chassis_screen_point(canvas)
        page.mouse.move(chassis_x, chassis_y)
        page.mouse.down()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.chassisDragging === 'true'"
        )
        page.mouse.move(chassis_x + 84, chassis_y + 38, steps=10)
        page.mouse.up()
        page.wait_for_function(
            "Number(document.querySelector('.three-canvas')?.dataset.chassisDragCount) > 0"
        )
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.chassisDragging === 'false'"
        )
        moved = read_pose(canvas)
        assert abs(moved["x"] - before["x"]) + abs(moved["y"] - before["y"]) > 0.04
        assert_fixed_pose(before, moved)
        assert read_camera(canvas) == camera_before

        # A captured pointer that leaves the WebGL canvas must immediately end
        # the gesture. Returning with the mouse still held must not move again.
        chassis_x, chassis_y = chassis_screen_point(canvas)
        canvas_box = canvas.bounding_box()
        assert canvas_box
        page.mouse.move(chassis_x, chassis_y)
        page.mouse.down()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.chassisDragging === 'true'"
        )
        outside_x = min(canvas_box["x"] + canvas_box["width"] + 18, 1432)
        outside_y = min(max(chassis_y, 8), 892)
        page.mouse.move(outside_x, outside_y, steps=8)
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.chassisDragging === 'false'"
        )
        assert canvas.get_attribute("data-chassis-drag-gesture-state") == "cancelled-on-leave"
        pose_at_leave = read_pose(canvas)
        page.mouse.move(chassis_x + 25, chassis_y + 10, steps=5)
        page.wait_for_timeout(120)
        assert read_pose(canvas) == pose_at_leave
        page.mouse.up()

        page.keyboard.press("Escape")
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.chassisDragMode === 'idle'"
        )
        assert canvas.get_attribute("data-chassis-drag-exit-reason") == "escape"
        assert not page.locator(".point-cloud-view").evaluate(
            "node => node.classList.contains('is-chassis-drag-mode')"
        )

        page.screenshot(path="/tmp/atlas-chassis-plane-drag.png", full_page=True)
        print("chassis_drag_delta=", moved["x"] - before["x"], moved["y"] - before["y"])
        print("chassis_drag_count=", canvas.get_attribute("data-chassis-drag-count"))
        print("page_errors=", errors)
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
