import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
ROOT = Path(__file__).resolve().parents[1]


def read_pose(canvas):
    return {
        "x": float(canvas.get_attribute("data-robot-x")),
        "y": float(canvas.get_attribute("data-robot-y")),
        "z": float(canvas.get_attribute("data-robot-z")),
        "roll": float(canvas.get_attribute("data-robot-roll")),
        "pitch": float(canvas.get_attribute("data-robot-pitch")),
        "yaw": float(canvas.get_attribute("data-robot-yaw")),
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


def run():
    errors = []
    robot_requests = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(180_000)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on(
            "request",
            lambda request: robot_requests.append(request.url)
            if "/__atlas/robot-files/" in request.url
            else None,
        )

        page.goto(BASE_URL, wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator('input[type="file"][accept=".ply"]').set_input_files(
            str(ROOT / "tests/fixtures/rotation-map.ply")
        )
        page.locator(".three-canvas").wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")

        load_button = page.get_by_role("button", name="加载机器人", exact=True)
        assert load_button.is_visible()
        load_button.click()
        picker = page.get_by_role("dialog", name="robots 目录模型")
        picker.wait_for()
        option = page.get_by_role("option", name="加载机器人 botx_abx_zivid_m70")
        option.wait_for()
        assert option.is_visible()
        assert "URDF" in option.inner_text()
        option.click()

        canvas = page.locator(".three-canvas")
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )
        assert canvas.get_attribute("data-robot-origin") == "0,0,0"
        assert canvas.get_attribute("data-robot-model-format") == "urdf"
        assert canvas.get_attribute("data-robot-link-count") == "37"
        assert canvas.get_attribute("data-robot-joint-count") == "36"
        assert canvas.get_attribute("data-robot-zivid-count") == "2"
        assert canvas.get_attribute("data-robot-optical-frame-count") == "2"
        assert canvas.get_attribute("data-robot-web-override-count") == "2"
        left_tool = [
            float(value)
            for value in canvas.get_attribute("data-robot-left-tool-position").split(",")
        ]
        right_tool = [
            float(value)
            for value in canvas.get_attribute("data-robot-right-tool-position").split(",")
        ]
        waist = [
            float(value)
            for value in canvas.get_attribute("data-robot-waist-position").split(",")
        ]
        assert abs(left_tool[0] - right_tool[0]) < 1e-5
        assert abs(left_tool[1] + right_tool[1]) < 1e-5
        assert abs(left_tool[2] - right_tool[2]) < 1e-5
        assert left_tool[2] < waist[2]
        assert page.locator(".robot-picker").get_attribute("data-robot-picker-state") == "loaded"
        assert "2× Zivid" in page.get_by_label("机器人模型状态").inner_text()
        assert page.get_by_text("2 × Zivid · 2 optical frames", exact=True).is_visible()

        control = page.get_by_role("button", name="定位机器人模型")
        assert control.is_visible()
        assert page.get_by_role("button", name="切换机器人键盘控制").count() == 0
        assert control.get_attribute("aria-pressed") == "false"
        assert canvas.get_attribute("data-robot-control-enabled") == "false"
        assert canvas.get_attribute("data-robot-drive-model") == "mecanum-local-frame"

        control.click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotControlEnabled === 'true'"
        )
        assert control.get_attribute("aria-pressed") == "true"
        assert canvas.get_attribute("data-keyboard-control-owner") == "robot"
        assert "MECANUM DRIVE · ACTIVE" in page.get_by_label("机器人模型状态").inner_text()
        camera_before_control = read_camera(canvas)

        page.keyboard.press("w")
        page.wait_for_function(
            "Number(document.querySelector('.three-canvas')?.dataset.robotX) > 0.04"
        )
        pose_after_forward = read_pose(canvas)
        assert pose_after_forward["x"] > 0.04
        assert abs(pose_after_forward["y"]) < 1e-5
        assert read_camera(canvas) == camera_before_control

        page.keyboard.press("a")
        page.wait_for_function(
            "Number(document.querySelector('.three-canvas')?.dataset.robotY) > 0.04"
        )
        pose_after_strafe = read_pose(canvas)
        assert pose_after_strafe["y"] > 0.04

        page.keyboard.press("ArrowLeft")
        page.wait_for_function(
            "Number(document.querySelector('.three-canvas')?.dataset.robotYaw) > 4"
        )
        pose_after_yaw = read_pose(canvas)
        assert pose_after_yaw["yaw"] > 4
        assert read_camera(canvas) == camera_before_control

        robot_before_vertical_camera = read_pose(canvas)
        camera_before_vertical = read_camera(canvas)
        page.keyboard.press("q")
        page.wait_for_timeout(120)
        camera_after_vertical_up = read_camera(canvas)
        assert read_pose(canvas) == robot_before_vertical_camera
        assert camera_after_vertical_up[2] > camera_before_vertical[2] + 0.01
        assert camera_after_vertical_up[5] > camera_before_vertical[5] + 0.01
        assert all(
            abs(camera_after_vertical_up[index] - camera_before_vertical[index]) < 1e-8
            for index in (0, 1, 3, 4, 6, 7, 8)
        )
        page.keyboard.press("e")
        page.wait_for_timeout(120)
        camera_after_vertical_down = read_camera(canvas)
        assert read_pose(canvas) == robot_before_vertical_camera
        assert camera_after_vertical_down[2] < camera_after_vertical_up[2] - 0.01
        assert camera_after_vertical_down[5] < camera_after_vertical_up[5] - 0.01

        page.keyboard.press("w")
        page.wait_for_timeout(120)
        moved_pose = read_pose(canvas)
        assert moved_pose["x"] > pose_after_yaw["x"] + 0.04
        assert moved_pose["y"] > pose_after_yaw["y"] + 0.002
        assert moved_pose["z"] == 0
        assert moved_pose["roll"] == 0
        assert moved_pose["pitch"] == 0

        control.click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotControlEnabled === 'false'"
        )
        robot_before_camera_key = read_pose(canvas)
        camera_before_camera_key = read_camera(canvas)
        page.keyboard.press("w")
        page.wait_for_timeout(120)
        assert read_pose(canvas) == robot_before_camera_key
        assert any(
            abs(after - before) > 1e-7
            for after, before in zip(read_camera(canvas), camera_before_camera_key)
        )

        # Leave robot control active to prove refresh restores the pose but does
        # not automatically re-arm the keyboard ownership latch.
        control.click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotControlEnabled === 'true'"
        )
        moved_pose = read_pose(canvas)
        assert "键盘已接管" in page.locator(".robot-drive-row").inner_text()

        assert any("zivid_2_m70_official.glb" in url for url in robot_requests)
        assert not any("/ZividTwo.stl" in url for url in robot_requests)

        page.get_by_role("tab", name="虚拟示教与相机").click()
        with page.expect_download() as download_info:
            page.get_by_role("button", name="导出示教工程 JSON").click()
        exported = json.loads(Path(download_info.value.path()).read_text())
        assert exported["robot"]["relativePath"].endswith("botx_abx_zivid_m70.urdf")
        exported_pose = exported["robot"]["origin"]
        assert abs(exported_pose["position"]["x"] - moved_pose["x"]) < 1e-5
        assert abs(exported_pose["position"]["y"] - moved_pose["y"]) < 1e-5
        assert exported_pose["position"]["z"] == 0
        assert exported_pose["rpy"]["roll"] == 0
        assert exported_pose["rpy"]["pitch"] == 0
        assert abs(exported_pose["rpy"]["yaw"] - moved_pose["yaw"]) < 1e-5

        page.wait_for_timeout(500)
        stored_robot = page.evaluate(
            """
            async () => {
              const database = await new Promise((resolve, reject) => {
                const request = indexedDB.open('atlas-route-studio', 1);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              });
              const transaction = database.transaction('workspace-session', 'readonly');
              const record = await new Promise((resolve, reject) => {
                const request = transaction.objectStore('workspace-session').get('config');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              });
              database.close();
              return record?.config?.project?.robot || null;
            }
            """
        )
        assert stored_robot["relativePath"].endswith("botx_abx_zivid_m70.urdf")
        assert abs(stored_robot["origin"]["position"]["x"] - moved_pose["x"]) < 1e-5
        assert abs(stored_robot["origin"]["position"]["y"] - moved_pose["y"]) < 1e-5
        assert abs(stored_robot["origin"]["rpy"]["yaw"] - moved_pose["yaw"]) < 1e-5

        page.reload(wait_until="domcontentloaded")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator(".three-canvas").wait_for()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )
        assert page.locator(".session-guard").get_attribute("data-session-restored") == "true"
        assert page.locator(".robot-picker").get_attribute("data-robot-picker-state") == "loaded"
        assert canvas.get_attribute("data-robot-control-enabled") == "false"
        assert page.get_by_role("button", name="定位机器人模型").get_attribute(
            "aria-pressed"
        ) == "false"
        restored_pose = read_pose(canvas)
        assert abs(restored_pose["x"] - moved_pose["x"]) < 1e-5
        assert abs(restored_pose["y"] - moved_pose["y"]) < 1e-5
        assert abs(restored_pose["yaw"] - moved_pose["yaw"]) < 1e-5
        page.get_by_role("button", name="定位机器人模型").click()
        page.wait_for_timeout(250)

        dimensions = page.evaluate(
            "({sw:document.body.scrollWidth,cw:document.body.clientWidth,"
            "sh:document.body.scrollHeight,ch:document.body.clientHeight})"
        )
        assert dimensions["sw"] == dimensions["cw"]
        assert dimensions["sh"] == dimensions["ch"]
        page.screenshot(path="/tmp/atlas-robot-model.png", full_page=True)

        print("robot_metrics=", page.get_by_label("机器人模型状态").inner_text())
        print("robot_requests=", len(robot_requests))
        print("page_errors=", errors)
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
