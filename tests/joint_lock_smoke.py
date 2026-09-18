import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

from archive_helpers import read_exported_project


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
ROOT = Path(__file__).resolve().parents[1]


def scene_joint_values(page):
    raw = page.locator(".three-canvas").get_attribute("data-robot-joint-values")
    return json.loads(raw or "{}")


def number_attr(canvas, name):
    return float(canvas.get_attribute(f"data-{name}"))


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

        page.goto(f"{BASE_URL.rstrip('/')}/workbench", wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
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
        page.get_by_role("tab", name="虚拟示教与相机").click()
        page.get_by_role("button", name="打开全关节浮动窗口").click()

        panel = page.get_by_label("机器人全关节控制", exact=True)
        floating = page.get_by_label("全关节控制浮动窗口", exact=True)
        panel.wait_for()
        lock_buttons = panel.locator(".joint-value-row__lock")
        assert lock_buttons.count() == 24
        default_body_locks = [
            "ankle_pitch_J",
            "knee_pitch_J",
            "waist_pitch_J",
            "waist_yaw_J",
        ]
        assert panel.get_attribute("data-locked-joint-count") == "4"
        assert json.loads(panel.get_attribute("data-locked-joint-names")) == default_body_locks
        for joint_name in default_body_locks:
            assert panel.locator(
                f'[data-joint-name="{joint_name}"]'
            ).get_attribute("data-joint-locked") == "true"
        page.screenshot(path="/tmp/atlas-joint-lock-recon.png", full_page=True)
        print("stage=lock-ui-ready", flush=True)

        waist_row = panel.locator('[data-joint-name="waist_pitch_J"]')
        waist_value = page.get_by_role("spinbutton", name="waist_pitch_J 关节值")
        waist_value.fill("24")
        waist_value.press("Enter")
        page.wait_for_function(
            "Math.abs(JSON.parse(document.querySelector('.three-canvas')?.dataset.robotJointValues || '{}').waist_pitch_J - 24) < 1e-6"
        )

        assert waist_row.get_attribute("data-joint-locked") == "true"
        assert panel.get_attribute("data-locked-joint-count") == "4"
        assert json.loads(panel.get_attribute("data-locked-joint-names")) == default_body_locks
        canvas = page.locator(".three-canvas")
        assert canvas.get_attribute("data-robot-joint-lock-count") == "4"
        assert json.loads(canvas.get_attribute("data-robot-joint-locked-names")) == default_body_locks

        # An IK lock only removes this degree of freedom from inverse solving;
        # direct slider/numeric adjustment remains available for fine tuning.
        assert waist_value.is_enabled()
        waist_value.fill("27")
        waist_value.press("Enter")
        page.wait_for_function(
            "Math.abs(JSON.parse(document.querySelector('.three-canvas')?.dataset.robotJointValues || '{}').waist_pitch_J - 27) < 1e-6"
        )

        floating.get_by_role("button", name="最小化全关节浮动窗口").click()
        page.get_by_role("button", name="定位机器人模型", exact=True).click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotControlEnabled === 'true'"
        )
        page.wait_for_timeout(300)
        double_click_tool(page, canvas, "left")
        endpoint_panel = page.get_by_label("机械臂末端空间球", exact=True)
        endpoint_panel.wait_for()

        before = scene_joint_values(page)
        target_x = number_attr(canvas, "end-effector-target-x") + 0.025
        endpoint_x = page.get_by_role("spinbutton", name="末端 X (m)")
        endpoint_x.fill(f"{target_x:.6f}")
        endpoint_x.press("Enter")
        page.wait_for_function(
            "([target]) => Math.abs(Number(document.querySelector('.three-canvas')?.dataset.endEffectorTargetX) - target) < 1e-5",
            arg=[target_x],
        )
        after = scene_joint_values(page)
        assert abs(after["waist_pitch_J"] - 27) < 1e-6
        assert number_attr(canvas, "end-effector-frozen-joint-count") >= 1
        assert max(
            abs(after[name] - before[name])
            for name in before
            if name.startswith("left_J")
        ) > 0.001
        print("stage=ik-lock-held", flush=True)

        page.get_by_role("button", name="打开示教数据管理页").click()
        page.locator('[data-app-page="teaching-data"]').wait_for()
        with page.expect_download() as download_info:
            page.get_by_role("button", name="导出示教工程 ZIP").click()
        exported = read_exported_project(download_info.value)
        assert exported["robot"]["lockedJoints"] == default_body_locks
        print("stage=export-lock-recorded", flush=True)
        page.get_by_role("button", name="返回主工作台继续示教").click()
        page.locator('[data-app-page="teaching-data"]').wait_for(state="detached")

        floating.get_by_role("button", name="展开全关节浮动窗口").click()
        page.get_by_role("button", name="解除全部关节 IK 锁定", exact=True).click()
        assert panel.get_attribute("data-locked-joint-count") == "0"
        assert waist_row.get_attribute("data-joint-locked") == "false"
        assert canvas.get_attribute("data-robot-joint-lock-count") == "0"

        page.get_by_role("button", name="锁定 waist_pitch_J 关节", exact=True).click()
        page.wait_for_timeout(700)
        page.reload(wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        print("stage=session-restored", flush=True)
        page.get_by_role("tab", name="虚拟示教与相机").click()
        page.get_by_role("button", name="打开全关节浮动窗口").click()
        restored_panel = page.get_by_label("机器人全关节控制", exact=True)
        restored_panel.wait_for()
        assert restored_panel.get_attribute("data-locked-joint-count") == "1"
        assert restored_panel.locator(
            '[data-joint-name="waist_pitch_J"]'
        ).get_attribute("data-joint-locked") == "true"
        assert page.locator(".three-canvas").get_attribute(
            "data-robot-joint-lock-count"
        ) == "1"
        floating = page.get_by_label("全关节控制浮动窗口", exact=True)
        floating.screenshot(path="/tmp/atlas-joint-lock.png", timeout=30_000)

        print("locked_joint=", "waist_pitch_J")
        print("locked_value=", scene_joint_values(page)["waist_pitch_J"])
        print("page_errors=", errors)
        assert not errors, errors
        browser.close()


if __name__ == "__main__":
    run()
