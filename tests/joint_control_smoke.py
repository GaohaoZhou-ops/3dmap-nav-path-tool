import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

from archive_helpers import read_exported_project


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
    map_file = Path(
        os.environ.get("MAP_FILE", str(ROOT / "tests/fixtures/rotation-map.ply"))
    ).expanduser().resolve()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(180_000)
        page.on("pageerror", lambda error: errors.append(str(error)))

        page.goto(f"{BASE_URL.rstrip('/')}/workbench", wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.get_by_role("tab", name="虚拟示教与相机").click()

        floating_window = page.get_by_label("全关节控制浮动窗口", exact=True)
        assert floating_window.count() == 0
        joint_toggle = page.get_by_role("button", name="打开全关节浮动窗口")
        assert joint_toggle.get_attribute("aria-pressed") == "false"
        joint_toggle.click()
        floating_window = page.get_by_label("全关节控制浮动窗口", exact=True)
        floating_window.wait_for()
        assert floating_window.is_visible()
        assert floating_window.get_attribute("data-floating-window") == "robot-joints"
        assert floating_window.get_attribute("data-window-state") == "open"
        assert page.get_by_role("button", name="隐藏全关节浮动窗口").get_attribute("aria-pressed") == "true"
        panel = page.get_by_label("机器人全关节控制", exact=True)
        assert panel.is_visible()
        assert panel.evaluate(
            "node => node.closest('[data-floating-window]')?.dataset.floatingWindow"
        ) == "robot-joints"
        assert panel.get_attribute("data-robot-ready") == "false"
        assert page.locator(".joint-value-row").count() == 0

        titlebar = floating_window.locator(".joint-float-window__titlebar")
        initial_x = float(floating_window.get_attribute("data-window-x"))
        initial_y = float(floating_window.get_attribute("data-window-y"))
        titlebar_box = titlebar.bounding_box()
        assert titlebar_box
        page.mouse.move(titlebar_box["x"] + 70, titlebar_box["y"] + 20)
        page.mouse.down()
        page.mouse.move(titlebar_box["x"] + 145, titlebar_box["y"] + 65, steps=6)
        page.mouse.up()
        assert float(floating_window.get_attribute("data-window-x")) > initial_x + 60
        assert float(floating_window.get_attribute("data-window-y")) > initial_y + 30
        titlebar.dblclick(position={"x": 70, "y": 20})
        assert abs(float(floating_window.get_attribute("data-window-x")) - initial_x) < 2
        assert abs(float(floating_window.get_attribute("data-window-y")) - initial_y) < 2

        floating_window.get_by_role("button", name="最小化全关节浮动窗口").click()
        assert floating_window.get_attribute("data-window-state") == "minimized"
        assert not panel.is_visible()
        floating_window.get_by_role("button", name="展开全关节浮动窗口").click()
        assert floating_window.get_attribute("data-window-state") == "open"
        assert panel.is_visible()

        floating_window.get_by_role("button", name="关闭全关节浮动窗口").click()
        floating_window.wait_for(state="detached")
        page.get_by_role("button", name="打开全关节浮动窗口").click()
        floating_window = page.get_by_label("全关节控制浮动窗口", exact=True)
        floating_window.wait_for()
        panel = page.get_by_label("机器人全关节控制", exact=True)
        assert panel.is_visible()

        page.get_by_role("tab", name="工程配置").click()
        assert floating_window.is_visible()
        assert panel.is_visible()
        page.get_by_role("tab", name="虚拟示教与相机").click()

        page.locator('input[type="file"][accept=".ply"]').set_input_files(
            str(map_file)
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

        page.get_by_role("button", name="新建示教任务").click()
        page.get_by_role("dialog", name="新建示教任务").get_by_role(
            "button", name="创建任务", exact=True
        ).click()
        page.wait_for_function(
            "document.querySelector('[aria-label=\"虚拟示教\"]')?.dataset.teachingTaskCount === '1'"
        )
        zivid_panel = page.get_by_label("Zivid 2 M70 相机视图", exact=True)
        assert zivid_panel.is_visible()
        assert page.get_by_label("相机视角反算示教", exact=True).count() == 0
        assert page.get_by_role("tab", name="相机反算", exact=True).count() == 0
        assert zivid_panel.get_attribute("data-camera-teaching-activation") == "automatic"
        assert zivid_panel.get_attribute("data-camera-teaching-mode") == "active"
        assert page.get_by_text("相机反算已激活", exact=True).count() == 0
        assert page.locator(".zivid-camera-inverse-badge").count() == 0
        assert floating_window.is_visible()
        assert panel.is_visible()
        assert page.locator(".three-canvas").is_visible()
        camera_canvas = zivid_panel.get_by_label("Zivid 2 M70 仿真相机画面", exact=True)
        camera_buffer_strategies = camera_canvas.get_attribute(
            "data-gpu-buffer-strategy"
        ).split("+")
        assert "dedicated-downsample" in camera_buffer_strategies
        assert camera_canvas.get_attribute("data-source-buffer-reused") == "false"
        source_point_count = int(camera_canvas.get_attribute("data-source-point-count"))
        render_point_count = int(camera_canvas.get_attribute("data-render-point-count"))
        camera_buffer_bytes = int(camera_canvas.get_attribute("data-camera-buffer-bytes"))
        assert render_point_count <= min(source_point_count, 360_000)
        assert camera_buffer_bytes <= render_point_count * 15
        if source_point_count > 360_000:
            assert render_point_count == 360_000
            assert camera_canvas.get_attribute("data-downsampled") == "true"
        context_loss_canceled = camera_canvas.evaluate(
            """
            canvas => {
              const event = new Event('webglcontextlost', { cancelable: true });
              canvas.dispatchEvent(event);
              return event.defaultPrevented;
            }
            """
        )
        assert context_loss_canceled
        page.wait_for_function(
            "document.querySelector('[aria-label=\"Zivid 2 M70 相机视图\"]')?.dataset.rendererStatus === 'context-lost'"
        )
        assert page.locator(".app-shell").is_visible()
        camera_canvas.evaluate(
            "canvas => canvas.dispatchEvent(new Event('webglcontextrestored'))"
        )
        page.wait_for_function(
            "document.querySelector('[aria-label=\"Zivid 2 M70 相机视图\"]')?.dataset.rendererStatus === 'ready'"
        )
        if os.environ.get("CAMERA_BUFFER_ONLY") == "1":
            print("map_file=", map_file.name)
            print("camera_points=", f"{render_point_count}/{source_point_count}")
            print("camera_buffer_bytes=", camera_buffer_bytes)
            print("page_errors=", errors)
            assert not errors, errors
            browser.close()
            return

        zivid_panel.get_by_role("button", name="放大 Zivid 相机视图").click()
        camera_modal = page.get_by_label("Zivid 2 M70 相机大图", exact=True)
        camera_modal.wait_for()
        floating_window.wait_for(state="hidden")
        zivid_panel = camera_modal.get_by_label("Zivid 2 M70 相机视图", exact=True)
        camera_teach = camera_modal.get_by_label("相机视角反算示教", exact=True)
        camera_teach.wait_for()
        assert camera_teach.get_attribute("data-attached-to-camera") == "true"
        assert camera_teach.evaluate(
            "node => node.parentElement?.getAttribute('aria-label')"
        ) == "相机控制与主3D辅助区"
        assert camera_teach.evaluate(
            "node => node.nextElementSibling?.getAttribute('aria-label')"
        ) == "主3D辅助视角"
        view_deck = zivid_panel.get_by_label("Zivid相机主画面", exact=True)
        side_stack = zivid_panel.get_by_label("相机控制与主3D辅助区", exact=True)
        camera_viewport = zivid_panel.get_by_label("M70 相机画面交互区", exact=True)
        main_viewport = zivid_panel.get_by_label("主3D辅助视角", exact=True)
        deck_box = view_deck.bounding_box()
        side_stack_box = side_stack.bounding_box()
        viewport_box = camera_viewport.bounding_box()
        main_viewport_box = main_viewport.bounding_box()
        controls_box = camera_teach.bounding_box()
        assert deck_box and side_stack_box and viewport_box and main_viewport_box and controls_box
        assert abs(
            side_stack_box["x"] - (deck_box["x"] + deck_box["width"])
        ) < 3
        assert controls_box["y"] + controls_box["height"] <= main_viewport_box["y"] + 3
        assert abs(controls_box["x"] - main_viewport_box["x"]) < 3
        assert abs(controls_box["width"] - main_viewport_box["width"]) < 3
        assert abs((viewport_box["width"] / viewport_box["height"]) - (1944 / 1200)) < 0.01
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
        linear_step_slider = camera_teach.get_by_role("slider", name="相机位移步进")
        angular_step_slider = camera_teach.get_by_role("slider", name="相机旋转步进")
        assert linear_step_slider.get_attribute("min") == "5"
        assert linear_step_slider.get_attribute("max") == "10"
        assert linear_step_slider.get_attribute("step") == "1"
        assert linear_step_slider.input_value() == "5"
        assert angular_step_slider.get_attribute("min") == "1"
        assert angular_step_slider.get_attribute("max") == "10"
        assert angular_step_slider.get_attribute("step") == "1"
        assert angular_step_slider.input_value() == "3"
        assert camera_teach.locator(".camera-teach-step-grid button").count() == 0
        assert camera_teach.get_attribute("data-linear-step") == "0.05"
        assert camera_teach.get_attribute("data-linear-step-cm") == "5"
        assert camera_teach.get_attribute("data-angular-step") == "3"

        linear_step_slider.fill("7")
        angular_step_slider.fill("8")
        assert camera_teach.get_attribute("data-linear-step") == "0.07"
        assert camera_teach.get_attribute("data-linear-step-cm") == "7"
        assert camera_teach.get_attribute("data-angular-step") == "8"
        assert camera_teach.get_by_role("button", name="左臂相机靠近").get_attribute(
            "title"
        ) == "靠近 · 70 mm"

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
        assert camera_teach.get_by_role("button", name="右臂相机右转").get_attribute(
            "title"
        ) == "右转 · 8°"
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

        joint_adjust_button = camera_modal.get_by_role(
            "button", name="打开全关节控制"
        )
        joint_adjust_button.wait_for()
        space_mouse_button = camera_modal.locator(".zivid-camera-spacemouse-toggle")
        space_mouse_button.wait_for()
        joint_button_box = joint_adjust_button.bounding_box()
        space_mouse_button_box = space_mouse_button.bounding_box()
        assert joint_button_box and space_mouse_button_box
        assert joint_button_box["x"] + joint_button_box["width"] <= space_mouse_button_box["x"]
        joint_adjust_button.click()
        floating_window.wait_for()
        assert floating_window.is_visible()
        assert floating_window.get_attribute("data-window-state") == "open"
        assert camera_modal.get_by_role(
            "button", name="全关节控制已打开"
        ).get_attribute("aria-pressed") == "true"
        assert int(floating_window.evaluate("node => getComputedStyle(node).zIndex")) > int(
            camera_modal.evaluate("node => getComputedStyle(node).zIndex")
        )
        expanded_viewport_box = camera_viewport.bounding_box()
        expanded_controls_box = camera_teach.bounding_box()
        assert expanded_viewport_box and expanded_controls_box
        assert abs(
            expanded_controls_box["x"]
            - side_stack_box["x"]
        ) < 3
        camera_modal.screenshot(
            path="/tmp/atlas-camera-teaching-expanded.png",
            timeout=30_000,
        )
        zivid_panel.get_by_role("button", name="关闭 Zivid 相机大图").click()
        camera_modal.wait_for(state="hidden")

        if os.environ.get("CAMERA_ONLY") == "1":
            print("map_file=", map_file.name)
            print("camera_points=", f"{render_point_count}/{source_point_count}")
            print("camera_buffer_bytes=", camera_buffer_bytes)
            print("page_errors=", errors)
            assert not errors, errors
            browser.close()
            return

        page.get_by_role("button", name="全部关节归零").click()
        page.wait_for_function(
            "Object.values(JSON.parse(document.querySelector('.three-canvas')?.dataset.robotJointValues || '{}')).every(value => Math.abs(value) < 1e-6)"
        )
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

        page.get_by_role("button", name="打开示教数据管理页").click()
        page.locator('[data-app-page="teaching-data"]').wait_for()
        with page.expect_download() as download_info:
            page.get_by_role("button", name="导出示教工程 ZIP").click()
        exported = read_exported_project(download_info.value)
        joint_poses = exported["virtualTeaching"]["jointPoses"]
        assert len(joint_poses) == 1
        assert joint_poses[0]["name"] == "双臂抓取预备"
        assert joint_poses[0]["joints"]["count"] == 24
        assert abs(joint_poses[0]["joints"]["values"]["right_J1"] - 35) < 1e-6
        assert abs(joint_poses[0]["joints"]["values"]["left_J1"] + 22) < 1e-6
        assert abs(joint_poses[0]["joints"]["values"]["wheel_LF_J"] + 270) < 1e-6
        assert abs(exported["robot"]["joints"]["right_J1"] - 35) < 1e-6
        page.get_by_role("button", name="返回主工作台继续示教").click()
        page.locator('[data-app-page="teaching-data"]').wait_for(state="detached")

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
                const request = transaction.objectStore('workspace-session').get('workspace-config:map');
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
        floating_window.screenshot(path="/tmp/atlas-joint-control.png", timeout=30_000)

        print("joint_count=", panel.get_attribute("data-joint-count"))
        print("joint_pose=", joint_poses[0]["name"])
        print("page_errors=", errors)
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
