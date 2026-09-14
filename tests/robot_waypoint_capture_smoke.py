import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
ROOT = Path(__file__).resolve().parents[1]
CHROMIUM_EXECUTABLE = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE")


def read_robot_pose(canvas):
    return {
        key: float(canvas.get_attribute(f"data-robot-{key}"))
        for key in ("x", "y", "z", "roll", "pitch", "yaw")
    }


def click_map_world(page, map_view, x, y):
    box = map_view.bounding_box()
    assert box
    scale = float(map_view.get_attribute("data-view-scale"))
    center_x = float(map_view.get_attribute("data-view-center-x"))
    center_y = float(map_view.get_attribute("data-view-center-y"))
    page.mouse.click(
        box["x"] + (x - center_x) * scale + box["width"] / 2,
        box["y"] + (center_y - y) * scale + box["height"] / 2,
    )


def run():
    errors = []
    with sync_playwright() as playwright:
        launch_options = {"headless": True}
        if CHROMIUM_EXECUTABLE:
            launch_options["executable_path"] = CHROMIUM_EXECUTABLE
        browser = playwright.chromium.launch(**launch_options)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(180_000)
        page.on("pageerror", lambda error: errors.append(str(error)))

        page.goto(BASE_URL, wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator('input[type="file"][accept=".ply"]').set_input_files(
            str(ROOT / "tests/fixtures/rotation-map.ply")
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.locator(".projection-status").wait_for(state="hidden")

        add_button = page.get_by_role("button", name="添加导航点", exact=True)
        map_view = page.locator(".map2d-view")
        assert map_view.bounding_box()

        # Without a loaded robot the same button only arms the original 2D
        # point-picking workflow; it must never create a false origin point.
        assert add_button.get_attribute("data-robot-waypoint-ready") is None
        add_button.click()
        assert add_button.get_attribute("aria-pressed") == "true"
        assert page.locator(".waypoint-marker").count() == 0
        click_map_world(page, map_view, -0.5, 0.8)
        page.wait_for_function(
            "document.querySelectorAll('.waypoint-marker').length === 1"
        )
        assert page.locator(".waypoint-marker").first.get_attribute(
            "data-waypoint-source"
        ) == "point-cloud-slice"

        page.get_by_role("button", name="加载机器人", exact=True).click()
        page.get_by_role(
            "option", name="加载机器人 botx_abx_zivid_m70"
        ).click()
        canvas = page.locator(".three-canvas")
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'"
        )
        page.get_by_role("button", name="定位机器人模型", exact=True).click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotControlEnabled === 'true'"
        )

        page.keyboard.press("w")
        page.wait_for_function(
            "Number(document.querySelector('.three-canvas')?.dataset.robotX) > 0.04"
        )
        page.keyboard.press("a")
        page.wait_for_function(
            "Number(document.querySelector('.three-canvas')?.dataset.robotY) > 0.04"
        )
        page.keyboard.press("ArrowLeft")
        page.wait_for_function(
            "Number(document.querySelector('.three-canvas')?.dataset.robotYaw) > 4"
        )
        robot_pose = read_robot_pose(canvas)

        # Clicking the toolbar action now captures the full live MAP pose and
        # keeps the 2D add mode armed for subsequent manual points.
        assert add_button.get_attribute("data-robot-waypoint-ready") == "true"
        add_button.click()
        page.wait_for_function(
            "document.querySelectorAll('.waypoint-marker').length === 2"
        )
        selected_marker = page.locator(".waypoint-marker.is-selected")
        assert selected_marker.get_attribute(
            "data-waypoint-source"
        ) == "robot-current-pose"
        assert add_button.get_attribute("aria-pressed") == "true"
        assert page.get_by_text(
            "XYZ 与 RPY 取自机器人当前 MAP 位姿", exact=False
        ).is_visible()

        pose_inputs = page.locator(
            ".property-editor .field-grid.three .numeric-field input"
        )
        assert pose_inputs.count() == 6
        for index, key in enumerate(("x", "y", "z", "roll", "pitch", "yaw")):
            assert abs(float(pose_inputs.nth(index).input_value()) - robot_pose[key]) < 0.011

        click_map_world(page, map_view, 3.5, 1.0)
        page.wait_for_function(
            "document.querySelectorAll('.waypoint-marker').length === 3"
        )
        assert page.locator(".waypoint-marker.is-selected").get_attribute(
            "data-waypoint-source"
        ) == "point-cloud-slice"
        page.screenshot(path="/tmp/atlas-robot-waypoint-capture.png", full_page=True)

        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
