import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
ROOT = Path(__file__).resolve().parents[1]


def number_attr(canvas, name):
    return float(canvas.get_attribute(f"data-{name}"))


def load_robot(page):
    page.get_by_role("button", name="加载机器人", exact=True).click()
    page.get_by_role("dialog", name="robots 目录模型").wait_for()
    page.get_by_role("option", name="加载机器人 botx_abx_zivid_m70").click()
    page.wait_for_function(
        "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
        timeout=180_000,
    )


def double_click_tool(page, canvas, side):
    page.wait_for_function(
        f"document.querySelector('.three-canvas')?.dataset.robot{side.title()}ToolScreenVisible === 'true'"
    )
    box = canvas.bounding_box()
    screen_x = number_attr(canvas, f"robot-{side}-tool-screen-x")
    screen_y = number_attr(canvas, f"robot-{side}-tool-screen-y")
    page.mouse.dblclick(box["x"] + screen_x, box["y"] + screen_y, delay=70)


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(180_000)
        page.on("pageerror", lambda error: errors.append(str(error)))

        page.goto(BASE_URL, wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator('input[type="file"][accept=".ply"]').set_input_files(
            str(ROOT / "tests/fixtures/rotation-map.ply")
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        canvas = page.locator(".three-canvas")
        load_robot(page)
        assert canvas.get_attribute("data-robot-end-effector-count") == "2"
        assert canvas.get_attribute("data-end-effector-control-state") == "idle"

        page.get_by_role("button", name="定位机器人模型").click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotControlEnabled === 'true'"
        )
        page.wait_for_timeout(350)
        initial_left = {
            axis: number_attr(canvas, f"robot-left-tool-world-{axis}")
            for axis in ("x", "y", "z")
        }
        double_click_tool(page, canvas, "left")
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotControlEnabled === 'false'"
        )

        panel = page.get_by_label("机械臂末端空间球")
        panel.wait_for()
        assert panel.get_attribute("data-end-effector-side") == "left"
        assert panel.get_attribute("data-transform-mode") == "translate"
        assert canvas.get_attribute("data-end-effector-space-ball-visible") == "true"
        assert canvas.get_attribute("data-end-effector-transform-attached") == "true"
        assert canvas.get_attribute("data-end-effector-center-mesh") == "none"
        assert canvas.get_attribute("data-end-effector-guide-style") == "rgb-rings-only"
        page.wait_for_function(
            "Number(document.querySelector('.three-canvas')?.dataset.endEffectorSpaceBallScreenDiameter) > 57"
        )

        target_x = number_attr(canvas, "end-effector-target-x") + 0.018
        x_field = page.get_by_role("spinbutton", name="末端 X (m)")
        x_field.fill(f"{target_x:.6f}")
        x_field.press("Enter")
        page.wait_for_function(
            "([expected]) => Math.abs(Number(document.querySelector('.three-canvas')?.dataset.endEffectorTargetX) - expected) < 1e-5",
            arg=[target_x],
        )
        actual_x = number_attr(canvas, "end-effector-actual-x")
        assert actual_x > initial_left["x"] + 0.004
        assert abs(actual_x - target_x) < 0.016

        page.get_by_role("button", name="RPY 旋转", exact=True).click()
        assert panel.get_attribute("data-transform-mode") == "rotate"
        target_yaw = number_attr(canvas, "end-effector-target-yaw") + 2.5
        yaw_field = page.get_by_role("spinbutton", name="末端 YAW (°)")
        yaw_field.fill(f"{target_yaw:.4f}")
        yaw_field.press("Enter")
        page.wait_for_function(
            "([expected]) => Math.abs(Number(document.querySelector('.three-canvas')?.dataset.endEffectorTargetYaw) - expected) < 1e-4",
            arg=[target_yaw],
        )
        assert number_attr(canvas, "end-effector-solve-count") >= 2
        assert canvas.get_attribute("data-end-effector-ik-status") in ("tracking", "limited")
        final_ik_status = canvas.get_attribute("data-end-effector-ik-status")

        with page.expect_download() as download_info:
            page.get_by_role("button", name="导出 JSON").click()
        locked_export = json.loads(Path(download_info.value.path()).read_text())
        locked_joint_values = locked_export["robot"]["joints"]
        locked_joint_names = [
            name
            for name in locked_joint_values
            if name.startswith("left_J") or name.startswith("waist_")
        ]
        assert locked_joint_names

        page.get_by_role("button", name="锁定左机械臂末端", exact=True).click()
        assert panel.get_attribute("data-end-effector-locked") == "true"
        assert panel.get_attribute("data-left-end-effector-locked") == "true"
        assert canvas.get_attribute("data-end-effector-left-locked") == "true"
        assert canvas.get_attribute("data-end-effector-active-locked") == "true"
        assert canvas.get_attribute("data-end-effector-space-ball-visible") == "false"
        assert canvas.get_attribute("data-end-effector-transform-attached") == "false"
        assert x_field.is_disabled()
        locked_left_pose = {
            axis: number_attr(canvas, f"robot-left-tool-world-{axis}")
            for axis in ("x", "y", "z")
        }

        initial_right = {
            axis: number_attr(canvas, f"robot-right-tool-world-{axis}")
            for axis in ("x", "y", "z")
        }
        double_click_tool(page, canvas, "right")
        page.wait_for_function(
            "document.querySelector('[aria-label=\"机械臂末端空间球\"]')?.dataset.endEffectorSide === 'right'"
        )
        assert panel.get_attribute("data-end-effector-locked") == "false"
        assert panel.get_attribute("data-left-end-effector-locked") == "true"
        assert canvas.get_attribute("data-end-effector-active-locked") == "false"
        assert canvas.get_attribute("data-end-effector-transform-attached") == "true"

        right_target_x = number_attr(canvas, "end-effector-target-x") + 0.018
        right_x_field = page.get_by_role("spinbutton", name="末端 X (m)")
        right_x_field.fill(f"{right_target_x:.6f}")
        right_x_field.press("Enter")
        page.wait_for_function(
            "([expected]) => Math.abs(Number(document.querySelector('.three-canvas')?.dataset.endEffectorTargetX) - expected) < 1e-5",
            arg=[right_target_x],
        )
        assert number_attr(canvas, "end-effector-actual-x") > initial_right["x"] + 0.004
        assert number_attr(canvas, "end-effector-frozen-joint-count") > 0
        held_left_pose = {
            axis: number_attr(canvas, f"robot-left-tool-world-{axis}")
            for axis in ("x", "y", "z")
        }
        assert all(
            abs(held_left_pose[axis] - locked_left_pose[axis]) < 1e-6
            for axis in ("x", "y", "z")
        )
        page.screenshot(path="/tmp/atlas-end-effector-lock.png", full_page=True)

        with page.expect_download() as download_info:
            page.get_by_role("button", name="导出 JSON").click()
        exported = json.loads(Path(download_info.value.path()).read_text())
        joints = exported["robot"]["joints"]
        assert all(f"left_J{index}" in joints for index in range(1, 8))
        assert any(abs(joints[f"left_J{index}"]) > 0.001 for index in range(1, 8))
        assert any(abs(joints[f"right_J{index}"]) > 0.001 for index in range(1, 8))
        assert all(
            abs(joints[name] - locked_joint_values[name]) < 1e-7
            for name in locked_joint_names
        )

        double_click_tool(page, canvas, "left")
        page.wait_for_function(
            "document.querySelector('[aria-label=\"机械臂末端空间球\"]')?.dataset.endEffectorSide === 'left'"
        )
        assert panel.get_attribute("data-end-effector-locked") == "true"
        page.screenshot(path="/tmp/atlas-end-effector-locked-panel.png", full_page=True)
        page.get_by_role("button", name="解除锁定左机械臂末端", exact=True).click()
        assert panel.get_attribute("data-end-effector-locked") == "false"
        assert canvas.get_attribute("data-end-effector-left-locked") == "false"
        assert canvas.get_attribute("data-end-effector-space-ball-visible") == "true"
        assert canvas.get_attribute("data-end-effector-transform-attached") == "true"
        assert page.get_by_role("spinbutton", name="末端 X (m)").is_enabled()

        persisted_left = {
            axis: number_attr(canvas, f"robot-left-tool-world-{axis}")
            for axis in ("x", "y", "z")
        }

        page.get_by_role("button", name="退出机械臂末端控制").click()
        assert canvas.get_attribute("data-end-effector-control-state") == "idle"
        assert canvas.get_attribute("data-end-effector-space-ball-visible") == "false"
        page.wait_for_timeout(500)
        page.reload(wait_until="domcontentloaded")
        page.locator('[data-session-state="ready"]').wait_for()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )
        assert canvas.get_attribute("data-end-effector-control-state") == "idle"
        assert canvas.get_attribute("data-end-effector-left-locked") == "false"
        assert canvas.get_attribute("data-end-effector-right-locked") == "false"
        restored_left = {
            axis: number_attr(canvas, f"robot-left-tool-world-{axis}")
            for axis in ("x", "y", "z")
        }
        assert all(
            abs(restored_left[axis] - persisted_left[axis]) < 1e-4
            for axis in ("x", "y", "z")
        )

        print("ik_status=", final_ik_status)
        print("left_tool_initial=", initial_left)
        print("left_tool_restored=", restored_left)
        print("page_errors=", errors)
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
