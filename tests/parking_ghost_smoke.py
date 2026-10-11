import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

from viewer_tools_helpers import viewer_tool


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:22156")
ROOT = Path(__file__).resolve().parents[1]


def read_robot_pose(canvas):
    return {
        axis: float(canvas.get_attribute(f"data-robot-{axis}"))
        for axis in ("x", "y", "z", "roll", "pitch", "yaw")
    }


def wait_for_pose(page, expected):
    page.wait_for_function(
        """target => {
          const canvas = document.querySelector('.three-canvas');
          return canvas && Object.entries(target).every(([axis, value]) =>
            Math.abs(Number(canvas.getAttribute(`data-robot-${axis}`)) - value) < 1e-5);
        }""",
        arg=expected,
    )


def run():
    errors = []
    with sync_playwright() as playwright:
        executable_path = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE")
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=executable_path or None,
        )
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

        page.get_by_role("tab", name="示教").click()
        page.get_by_role("button", name="新建示教任务", exact=True).click()
        dialog = page.get_by_role("dialog", name="新建示教任务")
        dialog.get_by_role("button", name="添加当前位置为停车点").click()
        dialog.get_by_role("button", name="创建任务", exact=True).click()
        tree = page.get_by_label("示教任务与停车点树", exact=True)
        first_stop = tree.get_by_role(
            "treeitem", name="选择当前停车点 停车点 P01"
        )
        first_stop.wait_for()
        first_stop_pose = read_robot_pose(canvas)

        viewer_tool(page, name="定位机器人模型").click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotControlEnabled === 'true'"
        )
        page.keyboard.press("w")
        page.keyboard.press("w")
        page.keyboard.press("a")
        page.keyboard.press("ArrowLeft")
        page.wait_for_function(
            """() => {
              const canvas = document.querySelector('.three-canvas');
              return Math.hypot(Number(canvas?.dataset.robotX), Number(canvas?.dataset.robotY)) > 0.05
                && Number(canvas?.dataset.robotYaw) > 4;
            }"""
        )
        page.get_by_role("button", name="新增停车点", exact=True).click()
        second_stop = tree.get_by_role(
            "treeitem", name="选择当前停车点 停车点 P02"
        )
        second_stop.wait_for()
        before_preview = read_robot_pose(canvas)
        before_joint_values = json.loads(
            canvas.get_attribute("data-robot-joint-values") or "{}"
        )

        first_stop.click()
        ghost_card = page.get_by_label("停车点机器人虚影", exact=True)
        ghost_card.wait_for()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.parkingGhostState === 'visible'"
        )
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.synchronizedFocusState === 'settled'"
        )
        assert first_stop.get_attribute("data-ghost-preview") == "true"
        assert second_stop.get_attribute("data-ghost-preview") == "false"
        assert ghost_card.get_attribute("data-parking-point-id")
        assert int(ghost_card.get_attribute("data-frozen-joint-count")) > 0
        assert int(canvas.get_attribute("data-parking-ghost-mesh-count")) > 0
        assert int(canvas.get_attribute("data-parking-ghost-joint-count")) > 0
        assert float(canvas.get_attribute("data-parking-ghost-opacity")) == 0.24
        ghost_joint_values = json.loads(
            canvas.get_attribute("data-parking-ghost-joint-values") or "{}"
        )
        assert ghost_joint_values.keys() == before_joint_values.keys()
        for joint_name, joint_value in before_joint_values.items():
            assert abs(ghost_joint_values[joint_name] - joint_value) < 1e-6
        assert canvas.get_attribute("data-synchronized-focus-type") == "robot-ghost"
        assert float(canvas.get_attribute("data-parking-ghost-planar-distance")) > 0.05
        target_pose = canvas.get_attribute("data-parking-ghost-target-pose")
        after_preview = read_robot_pose(canvas)
        for axis, value in before_preview.items():
            assert abs(after_preview[axis] - value) < 1e-5, (axis, after_preview[axis], value)
        assert ghost_card.get_by_text("停车点 P02", exact=True).is_visible()
        assert ghost_card.get_by_text("停车点 P01", exact=True).is_visible()
        page.screenshot(path="/tmp/atlas-parking-robot-ghost.png", full_page=True)

        distance_before_move = float(
            canvas.get_attribute("data-parking-ghost-planar-distance")
        )
        page.keyboard.press("w")
        page.keyboard.press("w")
        page.wait_for_function(
            "distance => Math.abs(Number(document.querySelector('.three-canvas')?.dataset.parkingGhostPlanarDistance) - distance) > 0.02",
            arg=distance_before_move,
        )
        assert canvas.get_attribute("data-parking-ghost-target-pose") == target_pose
        assert first_stop.get_attribute("data-ghost-preview") == "true"

        page.get_by_role("button", name="清除停车点机器人虚影").click()
        ghost_card.wait_for(state="detached")
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.parkingGhostState === 'hidden'"
        )
        assert first_stop.get_attribute("data-ghost-preview") == "false"
        assert page.locator(".point-cloud-view").get_attribute(
            "data-parking-ghost-state"
        ) == "hidden"

        # Moving applies the selected parking pose, while keeping joints edited
        # after the ghost was created, and allows capture under that stop.
        first_stop.click()
        ghost_card.wait_for()
        target_id = ghost_card.get_attribute("data-parking-point-id")
        page.get_by_role("button", name="打开全关节浮动窗口").click()
        joint = page.get_by_role("spinbutton", name="right_J1 关节值")
        joint.fill("35")
        joint.press("Enter")
        page.get_by_role("button", name="关闭全关节浮动窗口").click()
        page.wait_for_function(
            "JSON.parse(document.querySelector('.three-canvas').dataset.robotJointValues).right_J1 === 35"
        )
        joints_before_move = json.loads(canvas.get_attribute("data-robot-joint-values"))
        move_button = ghost_card.get_by_role("button", name="移动到当前停车点", exact=True)
        assert move_button.is_enabled()
        move_button.click()
        ghost_card.wait_for(state="detached")
        wait_for_pose(page, first_stop_pose)
        assert json.loads(canvas.get_attribute("data-robot-joint-values")) == joints_before_move
        assert first_stop.get_attribute("aria-current") == "true"
        assert first_stop.get_attribute("data-ghost-preview") == "false"
        assert tree.get_attribute("data-active-parking-point") == target_id
        assert canvas.get_attribute("data-synchronized-focus-type") == "robot"

        capture_button = page.get_by_role("button", name="记录当前机械臂姿态", exact=True)
        assert capture_button.is_enabled()
        capture_button.click()
        page.wait_for_function(
            "document.querySelector('[aria-label=\"虚拟示教\"]')?.dataset.teachingPointCount === '1'"
        )
        assert first_stop.locator("small").inner_text() == "1 姿态"
        assert second_stop.locator("small").inner_text() == "0 姿态"

        second_stop.click()
        ghost_card.get_by_role("button", name="移动到当前停车点", exact=True).click()
        wait_for_pose(page, before_preview)
        capture_button.click()
        page.wait_for_function(
            "document.querySelector('[aria-label=\"虚拟示教\"]')?.dataset.teachingPointCount === '2'"
        )
        assert second_stop.locator("small").inner_text() == "1 姿态"

        # An explicit move must stop looping playback so later frames cannot
        # pull the robot away from the selected operating position.
        page.get_by_role("button", name="打开示教数据管理页").click()
        page.get_by_role("button", name="选择示教任务 示教任务 01", exact=True).click()
        page.get_by_role("button", name="播放示教任务 示教任务 01", exact=True).click()
        dock = page.get_by_label("示教任务轨迹播放控制", exact=True)
        dock.wait_for()
        assert dock.get_attribute("data-playback-status") == "playing"
        second_stop.click()
        ghost_card.get_by_role("button", name="移动到当前停车点", exact=True).click()
        dock.wait_for(state="detached")
        ghost_card.wait_for(state="detached")
        wait_for_pose(page, before_preview)
        page.wait_for_timeout(700)
        assert read_robot_pose(canvas) == before_preview
        assert json.loads(canvas.get_attribute("data-robot-joint-values")) == joints_before_move
        assert page.locator(".point-cloud-view").get_attribute("data-robot-trajectory-active") == "false"
        assert second_stop.get_attribute("aria-current") == "true"
        assert capture_button.is_enabled()
        assert not errors, errors
        browser.close()

    print("parking_ghost=created,current-pose-preserved,live-distance,cleared,moved,joints-preserved,captured,playback-stopped")


if __name__ == "__main__":
    run()
