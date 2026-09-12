import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:22070")
ROOT = Path(__file__).resolve().parents[1]


def scene_joint_values(page):
    raw = page.locator(".three-canvas").get_attribute("data-robot-joint-values")
    return json.loads(raw or "{}")


def scene_joint_transforms(page):
    raw = page.locator(".three-canvas").get_attribute("data-robot-joint-transforms")
    return json.loads(raw or "{}")


def vector_distance(left, right):
    return sum((float(a) - float(b)) ** 2 for a, b in zip(left, right)) ** 0.5


def csv_vector(element, attribute):
    return [float(value) for value in element.get_attribute(attribute).split(",")]


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(180_000)
        page.on("pageerror", lambda error: errors.append(str(error)))

        page.goto(BASE_URL, wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.get_by_role("tab", name="虚拟示教与相机").click()

        panel = page.get_by_label("机器人全关节控制", exact=True)
        assert panel.is_visible()
        assert panel.get_attribute("data-robot-ready") == "false"
        assert page.locator(".joint-value-row").count() == 0

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
        page.wait_for_function(
            "document.querySelector('[aria-label=\"机器人全关节控制\"]')?.dataset.jointCount === '24'"
        )

        assert panel.get_attribute("data-robot-ready") == "true"
        assert panel.get_attribute("data-joint-count") == "24"
        assert page.locator(".joint-value-row").count() == 24
        assert page.get_by_text("底盘轮组", exact=True).is_visible()
        assert page.get_by_text("左机械臂", exact=True).is_visible()
        assert page.get_by_text("右机械臂", exact=True).is_visible()

        canvas = page.locator(".three-canvas")
        assert canvas.get_attribute("data-robot-joint-applied-count") == "24"

        page.get_by_role("button", name="新建任务").click()
        page.wait_for_function(
            "document.querySelector('[aria-label=\"虚拟示教\"]')?.dataset.teachingTaskCount === '1'"
        )
        page.get_by_role("tab", name="相机反算", exact=True).click()
        camera_teach = page.get_by_label("相机视角反算示教", exact=True)
        assert camera_teach.is_visible()
        zivid_panel = page.get_by_label("Zivid 2 M70 相机视图", exact=True)
        assert zivid_panel.is_visible()
        assert camera_teach.get_attribute("data-attached-to-camera") == "true"
        assert camera_teach.evaluate(
            "node => node.parentElement?.getAttribute('aria-label')"
        ) == "Zivid 2 M70 相机视图"
        assert camera_teach.evaluate(
            "node => node.previousElementSibling?.getAttribute('aria-label')"
        ) == "M70 相机画面交互区"
        camera_viewport = zivid_panel.get_by_label("M70 相机画面交互区", exact=True)
        viewport_box = camera_viewport.bounding_box()
        controls_box = camera_teach.bounding_box()
        assert viewport_box and controls_box
        assert abs(controls_box["y"] - (viewport_box["y"] + viewport_box["height"])) < 3
        page.wait_for_function(
            "document.querySelector('[aria-label=\"相机视角反算示教\"]')?.dataset.cameraReady === 'true'"
        )
        assert camera_teach.locator("[data-camera-teach-action]").count() == 12
        assert set(
            camera_teach.locator("[data-camera-teach-action]").evaluate_all(
                "buttons => buttons.map(button => button.dataset.cameraTeachAction)"
            )
        ) == {
            "near", "far", "up", "down", "left", "right",
            "yaw-left", "yaw-right", "pitch-up", "pitch-down",
            "roll-left", "roll-right",
        }
        assert camera_teach.get_attribute("data-linear-step") == "0.025"
        assert camera_teach.get_attribute("data-angular-step") == "3"

        left_pose_before = csv_vector(canvas, "data-zivid-left-optical-position")
        joints_before_camera_move = scene_joint_values(page)
        camera_teach.get_by_role("button", name="左臂相机靠近").click()
        page.wait_for_function(
            """
            () => {
              const canvas = document.querySelector('.three-canvas');
              return Number(canvas?.dataset.cameraTeachingRevision) >= 1
                && canvas?.dataset.cameraTeachingState === 'settled';
            }
            """
        )
        page.wait_for_function(
            "['tracking', 'limited'].includes(document.querySelector('[aria-label=\"相机视角反算示教\"]')?.dataset.cameraTeachingStatus)"
        )
        assert canvas.get_attribute("data-camera-teaching-side") == "left"
        assert canvas.get_attribute("data-camera-teaching-action") == "near"
        assert canvas.get_attribute("data-camera-teaching-ik-status") in {"tracking", "limited"}
        left_pose_after = csv_vector(canvas, "data-zivid-left-optical-position")
        joints_after_camera_move = scene_joint_values(page)
        assert vector_distance(left_pose_before, left_pose_after) > 0.003
        assert max(
            abs(joints_after_camera_move[name] - joints_before_camera_move[name])
            for name in joints_before_camera_move
        ) > 0.05

        zivid_panel.get_by_role("button", name="右臂 M70").click()
        page.wait_for_function(
            "document.querySelector('[aria-label=\"Zivid 2 M70 相机视图\"]')?.dataset.cameraSide === 'right'"
        )
        right_quaternion_before = csv_vector(canvas, "data-zivid-right-optical-quaternion")
        first_revision = int(canvas.get_attribute("data-camera-teaching-revision"))
        camera_teach.get_by_role("button", name="右臂相机右转").click()
        page.wait_for_function(
            """
            previous => {
              const canvas = document.querySelector('.three-canvas');
              return Number(canvas?.dataset.cameraTeachingRevision) > previous
                && canvas?.dataset.cameraTeachingState === 'settled';
            }
            """,
            arg=first_revision,
        )
        right_quaternion_after = csv_vector(canvas, "data-zivid-right-optical-quaternion")
        assert canvas.get_attribute("data-camera-teaching-side") == "right"
        assert canvas.get_attribute("data-camera-teaching-action") == "yaw-right"
        assert vector_distance(right_quaternion_before, right_quaternion_after) > 0.003
        zivid_panel.screenshot(path="/tmp/atlas-camera-teaching.png", timeout=30_000)

        zivid_panel.get_by_role("button", name="放大 Zivid 相机视图").click()
        camera_modal = page.get_by_label("Zivid 2 M70 相机大图", exact=True)
        camera_modal.wait_for()
        expanded_viewport_box = camera_viewport.bounding_box()
        expanded_controls_box = camera_teach.bounding_box()
        assert expanded_viewport_box and expanded_controls_box
        assert abs(
            expanded_controls_box["x"]
            - (expanded_viewport_box["x"] + expanded_viewport_box["width"])
        ) < 3
        camera_modal.screenshot(
            path="/tmp/atlas-camera-teaching-expanded.png",
            timeout=30_000,
        )
        zivid_panel.get_by_role("button", name="关闭 Zivid 相机大图").click()
        camera_modal.wait_for(state="hidden")

        page.get_by_role("button", name="全部关节归零").click()
        page.wait_for_function(
            "Object.values(JSON.parse(document.querySelector('.three-canvas')?.dataset.robotJointValues || '{}')).every(value => Math.abs(value) < 1e-6)"
        )
        page.get_by_role("tab", name="姿态示教", exact=True).click()
        initial_transforms = scene_joint_transforms(page)
        initial_right_quaternion = initial_transforms["right_J1"]["quaternion"]
        initial_right_tool = [
            float(canvas.get_attribute("data-robot-right-tool-world-x")),
            float(canvas.get_attribute("data-robot-right-tool-world-y")),
            float(canvas.get_attribute("data-robot-right-tool-world-z")),
        ]

        # Use a real pointer gesture first. The range input must publish native
        # `input` events continuously, and the Three.js joint must follow each one.
        right_slider = page.get_by_role("slider", name="right_J1 关节滑块")
        right_slider.scroll_into_view_if_needed()
        slider_box = right_slider.bounding_box()
        assert slider_box and slider_box["width"] > 20
        slider_y = slider_box["y"] + slider_box["height"] / 2
        page.mouse.move(slider_box["x"] + slider_box["width"] / 2, slider_y)
        page.mouse.down()
        page.mouse.move(
            slider_box["x"] + slider_box["width"] * 0.72,
            slider_y,
            steps=8,
        )
        page.mouse.up()
        page.wait_for_function(
            "Math.abs(Number(document.querySelector('[data-joint-name=\"right_J1\"]')?.dataset.jointValue)) > 10"
        )
        page.wait_for_function(
            """
            () => {
              const expected = Number(
                document.querySelector('[data-joint-name="right_J1"]')?.dataset.jointValue
              );
              const actual = JSON.parse(
                document.querySelector('.three-canvas')?.dataset.robotJointValues || '{}'
              ).right_J1;
              return Number.isFinite(actual) && Math.abs(actual - expected) < 1e-6;
            }
            """
        )
        dragged_transforms = scene_joint_transforms(page)
        dragged_right_quaternion = dragged_transforms["right_J1"]["quaternion"]
        dragged_right_tool = [
            float(canvas.get_attribute("data-robot-right-tool-world-x")),
            float(canvas.get_attribute("data-robot-right-tool-world-y")),
            float(canvas.get_attribute("data-robot-right-tool-world-z")),
        ]
        assert vector_distance(initial_right_quaternion, dragged_right_quaternion) > 0.05
        assert vector_distance(initial_right_tool, dragged_right_tool) > 0.05

        right_joint = page.get_by_role("spinbutton", name="right_J1 关节值")
        left_joint = page.get_by_role("spinbutton", name="left_J1 关节值")
        wheel_joint = page.get_by_role("spinbutton", name="wheel_LF_J 关节值")
        right_joint.fill("35")
        right_joint.press("Enter")
        left_joint.fill("-22")
        left_joint.press("Enter")
        wheel_joint.fill("-270")
        wheel_joint.press("Enter")
        page.wait_for_function(
            "Math.abs(Number(document.querySelector('[data-joint-name=\"right_J1\"]')?.dataset.jointValue) - 35) < 1e-6"
        )
        page.wait_for_function(
            "Math.abs(Number(document.querySelector('[data-joint-name=\"left_J1\"]')?.dataset.jointValue) + 22) < 1e-6"
        )
        page.wait_for_function(
            "Math.abs(Number(document.querySelector('[data-joint-name=\"wheel_LF_J\"]')?.dataset.jointValue) + 270) < 1e-6"
        )
        page.wait_for_function(
            """
            () => {
              const values = JSON.parse(
                document.querySelector('.three-canvas')?.dataset.robotJointValues || '{}'
              );
              return Math.abs(values.right_J1 - 35) < 1e-6
                && Math.abs(values.left_J1 + 22) < 1e-6
                && Math.abs(values.wheel_LF_J + 270) < 1e-6;
            }
            """
        )

        pose_name = page.get_by_role("textbox", name="新关节姿态名称")
        pose_name.fill("双臂展开准备")
        page.get_by_role("button", name="记录当前关节姿态").click()
        page.wait_for_function(
            "document.querySelector('[aria-label=\"机器人全关节控制\"]')?.dataset.jointPoseCount === '1'"
        )
        saved_name = page.get_by_role("textbox", name="关节姿态 1 名称")
        assert saved_name.input_value() == "双臂展开准备"

        right_joint.fill("5")
        right_joint.press("Enter")
        left_joint.fill("6")
        left_joint.press("Enter")
        page.get_by_role("button", name="执行关节姿态 双臂展开准备").click()
        page.wait_for_function(
            "Math.abs(Number(document.querySelector('[data-joint-name=\"right_J1\"]')?.dataset.jointValue) - 35) < 1e-6"
        )
        assert float(right_joint.input_value()) == 35
        assert float(left_joint.input_value()) == -22
        assert float(wheel_joint.input_value()) == -270

        saved_name.fill("双臂抓取预备")
        saved_name.press("Enter")
        page.get_by_role("button", name="执行关节姿态 双臂抓取预备").wait_for()

        page.get_by_role("button", name="全部关节归零").click()
        page.wait_for_function(
            "Math.abs(Number(document.querySelector('[data-joint-name=\"right_J1\"]')?.dataset.jointValue)) < 1e-6"
        )
        assert all(
            abs(float(row.get_attribute("data-joint-value"))) < 1e-6
            for row in page.locator(".joint-value-row").all()
        )
        assert all(abs(value) < 1e-6 for value in scene_joint_values(page).values())
        zeroed_right_quaternion = scene_joint_transforms(page)["right_J1"]["quaternion"]
        assert vector_distance(initial_right_quaternion, zeroed_right_quaternion) < 1e-8

        page.get_by_role("button", name="执行关节姿态 双臂抓取预备").click()
        page.wait_for_function(
            "Math.abs(Number(document.querySelector('[data-joint-name=\"right_J1\"]')?.dataset.jointValue) - 35) < 1e-6"
        )
        page.wait_for_function(
            """
            () => Math.abs(
              JSON.parse(
                document.querySelector('.three-canvas')?.dataset.robotJointValues || '{}'
              ).right_J1 - 35
            ) < 1e-6
            """
        )

        with page.expect_download() as download_info:
            page.get_by_role("button", name="导出示教工程 JSON").click()
        exported = json.loads(Path(download_info.value.path()).read_text())
        joint_poses = exported["virtualTeaching"]["jointPoses"]
        assert len(joint_poses) == 1
        assert joint_poses[0]["name"] == "双臂抓取预备"
        assert joint_poses[0]["joints"]["count"] == 24
        assert abs(joint_poses[0]["joints"]["values"]["right_J1"] - 35) < 1e-6
        assert abs(joint_poses[0]["joints"]["values"]["left_J1"] + 22) < 1e-6
        assert abs(joint_poses[0]["joints"]["values"]["wheel_LF_J"] + 270) < 1e-6
        assert abs(exported["robot"]["joints"]["right_J1"] - 35) < 1e-6

        page.wait_for_timeout(600)
        stored_joint_poses = page.evaluate(
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
              return record?.config?.project?.virtualTeaching?.jointPoses || [];
            }
            """
        )
        assert len(stored_joint_poses) == 1
        assert stored_joint_poses[0]["name"] == "双臂抓取预备"
        assert stored_joint_poses[0]["joints"]["count"] == 24

        page.locator(".three-canvas").evaluate(
            "element => { element.style.visibility = 'hidden'; }"
        )
        panel.screenshot(path="/tmp/atlas-joint-control.png", timeout=30_000)

        print("joint_count=", panel.get_attribute("data-joint-count"))
        print("joint_pose=", joint_poses[0]["name"])
        print("page_errors=", errors)
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
