import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990").rstrip("/")
FIXTURE = Path(__file__).parent / "fixtures" / "rotation-map.ply"
CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")


def canvas_pose(canvas):
    return {
        key: float(canvas.get_attribute(f"data-robot-{key}"))
        for key in ("x", "y", "z", "yaw")
    }


def run():
    errors = []
    with sync_playwright() as playwright:
        options = {"headless": True}
        if CHROME.exists():
            options["executable_path"] = str(CHROME)
        browser = playwright.chromium.launch(**options)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(30_000)
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        page.goto(f"{BASE_URL}/workbench", wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        assert page.get_by_role("button", name="复位机器人关节姿态").count() == 0

        page.locator('input[type="file"][accept=".ply"]').set_input_files(str(FIXTURE))
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.get_by_role("button", name="加载机器人", exact=True).click()
        page.get_by_role(
            "option", name="加载机器人 botx_abx_zivid_m70"
        ).click()

        canvas = page.locator(".three-canvas")
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )
        reset_button = page.get_by_role("button", name="复位机器人关节姿态")
        assert reset_button.is_visible()
        assert reset_button.is_enabled()
        assert int(reset_button.get_attribute("data-resettable-joint-count")) > 0

        slice_control_box = page.locator(".height-range").bounding_box()
        slice_rail_box = page.locator(".height-range__rail").bounding_box()
        toolbar_box = page.locator(".viewer-tool-switch").bounding_box()
        assert slice_control_box and slice_rail_box and toolbar_box
        assert slice_control_box["height"] <= 227
        assert slice_rail_box["height"] <= 110
        assert slice_control_box["y"] >= toolbar_box["y"] + toolbar_box["height"]

        initial_pose = canvas_pose(canvas)
        page.get_by_role("button", name="打开全关节浮动窗口").click()
        right_joint = page.get_by_role("spinbutton", name="right_J1 关节值")
        left_joint = page.get_by_role("spinbutton", name="left_J1 关节值")
        right_joint.fill("35")
        right_joint.press("Enter")
        left_joint.fill("-22")
        left_joint.press("Enter")
        page.wait_for_function(
            """
            () => {
              const values = JSON.parse(
                document.querySelector('.three-canvas')?.dataset.robotJointValues || '{}'
              );
              return Math.abs(Number(values.right_J1) - 35) < 1e-6
                && Math.abs(Number(values.left_J1) + 22) < 1e-6;
            }
            """
        )

        joint_window = page.get_by_role("dialog", name="全关节控制浮动窗口")
        window_box = joint_window.bounding_box()
        assert window_box and window_box["width"] >= 500 and window_box["height"] >= 700
        typography = joint_window.evaluate(
            """
            (windowElement) => ({
              title: parseFloat(getComputedStyle(
                windowElement.querySelector('.joint-float-window__identity strong')
              ).fontSize),
              jointName: parseFloat(getComputedStyle(
                windowElement.querySelector('.joint-value-row__name strong')
              ).fontSize),
              jointValue: parseFloat(getComputedStyle(
                windowElement.querySelector('.joint-value-row__number input')
              ).fontSize),
              toolbar: parseFloat(getComputedStyle(
                windowElement.querySelector('.joint-console-toolbar strong')
              ).fontSize),
              group: parseFloat(getComputedStyle(
                windowElement.querySelector('.joint-group summary')
              ).fontSize),
              jointType: parseFloat(getComputedStyle(
                windowElement.querySelector('.joint-value-row__name small')
              ).fontSize),
            })
            """
        )
        assert typography["title"] >= 14
        assert typography["jointName"] >= 11
        assert typography["jointValue"] >= 11
        assert typography["toolbar"] >= 10
        assert typography["group"] >= 10
        assert typography["jointType"] >= 7
        page.screenshot(path="/tmp/atlas-joint-window-enlarged.png", full_page=True)

        page.get_by_role("button", name="关闭全关节浮动窗口").click()
        page.get_by_role("dialog", name="全关节控制浮动窗口").wait_for(
            state="detached"
        )
        reset_button.click()
        page.wait_for_function(
            """
            () => {
              const values = Object.values(JSON.parse(
                document.querySelector('.three-canvas')?.dataset.robotJointValues || '{}'
              ));
              return values.length > 0
                && values.every((value) => Math.abs(Number(value)) < 1e-6);
            }
            """
        )
        reset_values = json.loads(canvas.get_attribute("data-robot-joint-values"))
        assert reset_values
        assert all(abs(float(value)) < 1e-6 for value in reset_values.values())
        assert canvas_pose(canvas) == initial_pose
        page.screenshot(path="/tmp/atlas-robot-pose-reset.png", full_page=True)

        print("reset_joint_count=", len(reset_values))
        print("robot_pose_unchanged=", initial_pose)
        print("joint_window_typography=", typography)
        print("page_errors=", errors)
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
