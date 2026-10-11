import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

from viewer_tools_helpers import viewer_tool


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:22145")
ROOT = Path(__file__).resolve().parents[1]


def scene_joint(page, name):
    raw = page.locator(".three-canvas").get_attribute("data-robot-joint-values")
    return float(json.loads(raw or "{}").get(name, 0))


def scene_pose(page):
    canvas = page.locator(".three-canvas")
    return {
        key: float(canvas.get_attribute(f"data-robot-{key}"))
        for key in ("x", "y", "z", "roll", "pitch", "yaw")
    }


def scene_view(page):
    return page.locator(".three-canvas").evaluate(
        """canvas => {
          const data = canvas.dataset;
          const vector = prefix => ['X', 'Y', 'Z'].map(axis => Number(data[prefix + axis]));
          return {
            camera: vector('camera'),
            target: vector('target'),
            robot: vector('robot'),
            up: vector('cameraUp'),
            zoom: Number(data.opticalZoom),
          };
        }"""
    )


def assert_following(before, after):
    # TrackballControls reports camera changes only above a 1 mm threshold.
    for key in ("camera", "target"):
        for axis in range(3):
            expected = before[key][axis] + after["robot"][axis] - before["robot"][axis]
            assert abs(after[key][axis] - expected) < 0.0015, (key, before, after)
    assert after["up"] == before["up"]
    assert after["zoom"] == before["zoom"]


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
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )
        page.wait_for_timeout(700)
        fixture = page.evaluate(
            """
            async () => {
              const database = await new Promise((resolve, reject) => {
                const request = indexedDB.open('atlas-route-studio', 1);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              });
              const read = () => new Promise((resolve, reject) => {
                const transaction = database.transaction('workspace-session', 'readonly');
                const request = transaction.objectStore('workspace-session').get('workspace-config:map');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              });
              let record = await read();
              for (let attempt = 0; !record && attempt < 30; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                record = await read();
              }
              if (!record?.config?.project?.robot || !record.config.project.map) {
                throw new Error('workspace fixture unavailable');
              }
              const project = record.config.project;
              const timestamp = new Date().toISOString();
              const pose = (x) => ({
                frameId: 'map',
                position: { x, y: 0, z: 0 },
                rpy: { roll: 0, pitch: 0, yaw: 0 },
              });
              const baseJoints = { ...(project.robot.joints || {}) };
              const teachPose = (id, name, sequence, x, rightJoint) => ({
                id,
                name,
                sequence,
                capturedAt: timestamp,
                mapPose: pose(x),
                fullBodyJoints: {
                  angularUnit: 'degree',
                  linearUnit: 'meter',
                  source: 'urdf-movable-joints',
                  values: { ...baseJoints, right_J1: rightJoint },
                },
                cameraCapture: null,
              });
              const task = {
                id: 'playback-task',
                name: '轨迹回放验证',
                sequence: 1,
                createdAt: timestamp,
                updatedAt: timestamp,
                coordinateFrame: 'map',
                robot: {
                  id: project.robot.id,
                  name: project.robot.name,
                  relativePath: project.robot.relativePath,
                },
                map: {
                  id: project.map.id || '',
                  fileName: project.map.fileName,
                  sourceHash: project.map.sourceHash,
                },
                parkingPoints: [
                  {
                    id: 'playback-stop-1', name: '停车点 P01', sequence: 1,
                    createdAt: timestamp, updatedAt: timestamp, mapPose: pose(0),
                    poses: [
                      teachPose('playback-pose-1', 'A01', 1, 0, 0),
                      teachPose('playback-pose-2', 'A02', 2, 0, 30),
                    ],
                  },
                  {
                    id: 'playback-stop-2', name: '停车点 P02', sequence: 2,
                    createdAt: timestamp, updatedAt: timestamp, mapPose: pose(0.12),
                    poses: [teachPose('playback-pose-3', 'A01', 1, 0.12, -20)],
                  },
                ],
              };
              project.virtualTeaching = {
                ...(project.virtualTeaching || {}),
                tasks: [task],
              };
              // The live robot differs from the first recording in both
              // chassis position/orientation and joints.
              project.robot.origin = pose(0.3);
              project.robot.origin.position.y = -0.2;
              project.robot.origin.rpy.yaw = 25;
              project.robot.joints = { ...baseJoints, right_J1: -10 };
              record.config.ui.activeTeachingTaskId = task.id;
              record.config.ui.activeTeachingParkingPointId = 'playback-stop-2';
              await new Promise((resolve, reject) => {
                const transaction = database.transaction('workspace-session', 'readwrite');
                transaction.objectStore('workspace-session').put(record);
                transaction.oncomplete = resolve;
                transaction.onerror = () => reject(transaction.error);
              });
              database.close();
              return { secondStopPose: pose(0.12), rightJoint: -10 };
            }
            """
        )
        page.reload(wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )
        page.wait_for_function(
            "Math.abs(JSON.parse(document.querySelector('.three-canvas')?.dataset.robotJointValues || '{}').right_J1 + 10) < 0.001"
        )
        second_stop_pose = {
            **fixture["secondStopPose"]["position"],
            **fixture["secondStopPose"]["rpy"],
        }
        height_range = page.locator(".height-range")
        initial_slice = [height_range.get_attribute(f"data-slice-{edge}") for edge in ("min", "max")]
        page.get_by_role("button", name="展开 Z 截面").click()
        assert page.get_by_role("button", name="收起 Z 截面").get_attribute("aria-expanded") == "true"

        page.get_by_role("button", name="打开示教数据管理页").click()
        page.locator('[data-app-page="teaching-data"]').wait_for()
        page.get_by_role("button", name="选择示教任务 轨迹回放验证").click()
        play_task = page.get_by_role("button", name="播放示教任务 轨迹回放验证")
        assert play_task.is_enabled()
        play_task.click()

        start_snapshot = page.wait_for_function(
            """() => {
              const dock = document.querySelector('.teaching-playback-dock');
              const canvas = document.querySelector('.three-canvas');
              if (!dock || !canvas) return false;
              return {
                ...dock.dataset,
                pose: ['X', 'Y', 'Z', 'Roll', 'Pitch', 'Yaw'].map(
                  axis => Number(canvas.dataset[`robot${axis}`]),
                ),
                joint: JSON.parse(canvas.dataset.robotJointValues).right_J1,
              };
            }"""
        ).json_value()
        assert start_snapshot["playbackCycle"] == "1"
        assert start_snapshot["playbackPhase"] == "hold"
        assert start_snapshot["playbackPose"] == "1/3"
        assert start_snapshot["playbackReachedPose"] == "1/3"
        assert all(abs(value) < 0.001 for value in start_snapshot["pose"])
        assert abs(start_snapshot["joint"]) < 0.001

        page.locator('[data-app-page="teaching-data"]').wait_for(state="detached")
        assert page.url.rstrip("/") == f"{BASE_URL.rstrip('/')}/workbench"
        dock = page.get_by_label("示教任务轨迹播放控制", exact=True)
        dock.wait_for()
        assert dock.get_attribute("data-playback-status") == "playing"
        assert dock.get_attribute("data-playback-task")
        assert dock.get_attribute("data-playback-pose").endswith("/3")
        assert dock.get_attribute("data-playback-cycle") == "1"
        follow_switch = page.get_by_role("switch", name="跟随机器人", exact=True)
        assert follow_switch.get_attribute("aria-checked") == "false"
        assert page.get_by_role("button", name="展开 Z 截面").get_attribute("aria-expanded") == "false"
        assert [height_range.get_attribute(f"data-slice-{edge}") for edge in ("min", "max")] == initial_slice
        assert page.locator(".point-cloud-view").get_attribute(
            "data-robot-trajectory-active"
        ) == "true"
        assert viewer_tool(page, name="定位机器人模型").is_disabled()
        page.get_by_role("combobox", name="示教轨迹播放速度").select_option("0.5")
        page.wait_for_timeout(700)
        page.screenshot(path="/tmp/atlas-teaching-playback-active.png", full_page=True)

        # The dock retracts towards its left edge without interrupting playback.
        expanded_box = dock.bounding_box()
        elapsed_before_collapse = int(dock.get_attribute("data-playback-elapsed-ms"))
        page.get_by_role("button", name="向左收起播放控制条").click()
        page.wait_for_timeout(350)
        collapsed_box = dock.bounding_box()
        assert abs(collapsed_box["x"] - expanded_box["x"]) < 1
        assert collapsed_box["width"] <= 32
        assert dock.get_attribute("data-playback-status") == "playing"
        assert int(dock.get_attribute("data-playback-elapsed-ms")) > elapsed_before_collapse
        assert page.get_by_role("button", name="暂停示教轨迹播放").count() == 0
        page.screenshot(path="/tmp/atlas-teaching-playback-collapsed.png", full_page=True)
        expand_dock = page.get_by_role("button", name="展开播放控制条")
        assert expand_dock.get_attribute("aria-expanded") == "false"
        expand_dock.press("Enter")
        page.get_by_role("button", name="暂停示教轨迹播放").wait_for()

        page.wait_for_function(
            """
            () => {
              const dock = document.querySelector('[aria-label="示教任务轨迹播放控制"]');
              const canvas = document.querySelector('.three-canvas');
              if (dock?.dataset.playbackPhase !== 'joints' || !canvas) return false;
              const ordinal = Number((dock.dataset.playbackPose || '').split('/')[0]);
              const value = Number(JSON.parse(canvas.dataset.robotJointValues || '{}').right_J1);
              const ranges = { 2: [0, 30], 3: [-20, 30] };
              const range = ranges[ordinal];
              return range && value > range[0] + 0.02 && value < range[1] - 0.02;
            }
            """,
            timeout=30_000,
        )
        page.evaluate(
            "document.querySelector('[aria-label=\"暂停示教轨迹播放\"]')?.click()"
        )
        page.wait_for_function(
            "document.querySelector('[aria-label=\"示教任务轨迹播放控制\"]')?.dataset.playbackStatus === 'paused'"
        )
        paused_joint = scene_joint(page, "right_J1")
        paused_pose = scene_pose(page)
        page.wait_for_timeout(450)
        assert abs(scene_joint(page, "right_J1") - paused_joint) < 0.0001
        assert abs(scene_pose(page)["x"] - paused_pose["x"]) < 0.0001

        # Following is an accessible boolean switch. Enabling it recenters the
        # robot without changing the viewing angle or zoom.
        before_follow = scene_view(page)
        follow_switch.press("Space")
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotFollowEnabled === 'true'"
        )
        assert follow_switch.get_attribute("aria-checked") == "true"
        followed_view = scene_view(page)
        for axis in range(3):
            old_offset = before_follow["camera"][axis] - before_follow["target"][axis]
            new_offset = followed_view["camera"][axis] - followed_view["target"][axis]
            assert abs(new_offset - old_offset) < 0.0015, (before_follow, followed_view)
        assert followed_view["zoom"] == before_follow["zoom"]
        page.wait_for_timeout(200)
        assert scene_view(page) == followed_view

        # Manually opening the slice stays possible, and both controls fit even
        # at the app's minimum supported viewport width.
        page.get_by_role("button", name="展开 Z 截面").click()
        assert page.get_by_role("slider", name="截面中心高度", exact=True).is_visible()
        for width in (1440, 1180, 980):
            page.set_viewport_size({"width": width, "height": 900})
            page.wait_for_timeout(250)
            dock_box = dock.bounding_box()
            slice_box = page.get_by_role("dialog", name="3D Z 截面").bounding_box()
            assert dock_box["width"] <= 520
            assert (
                slice_box["y"] + slice_box["height"] + 8 <= dock_box["y"]
                or dock_box["x"] + dock_box["width"] + 8 <= slice_box["x"]
            )
            assert page.locator(".teaching-playback-dock__content").evaluate(
                "element => element.scrollWidth <= element.clientWidth"
            )
            for control in ("暂停示教轨迹播放", "继续示教轨迹播放", "停止示教轨迹播放"):
                button = page.get_by_role("button", name=control)
                if button.count():
                    box = button.bounding_box()
                    assert box["x"] >= dock_box["x"]
                    assert box["x"] + box["width"] <= dock_box["x"] + dock_box["width"]
            follow_box = follow_switch.bounding_box()
            assert follow_box["x"] >= dock_box["x"]
            assert follow_box["x"] + follow_box["width"] <= dock_box["x"] + dock_box["width"]
            page.screenshot(path=f"/tmp/atlas-teaching-playback-width-{width}.png", full_page=True)
        page.set_viewport_size({"width": 1440, "height": 900})
        page.get_by_role("combobox", name="示教轨迹播放速度").select_option("2")
        page.get_by_role("button", name="继续示教轨迹播放").click()
        assert page.get_by_role("button", name="展开 Z 截面").get_attribute("aria-expanded") == "false"
        assert [height_range.get_attribute(f"data-slice-{edge}") for edge in ("min", "max")] == initial_slice
        print(
            "playback_plan=",
            dock.get_attribute("data-playback-segment"),
            dock.get_attribute("data-playback-elapsed-ms"),
            dock.get_attribute("data-playback-total-ms"),
            dock.get_attribute("data-playback-speed"),
            flush=True,
        )
        page.wait_for_function(
            """() => {
              const data = document.querySelector('.teaching-playback-dock')?.dataset;
              return data?.playbackPose === '3/3' && data.playbackPhase === 'hold';
            }""",
            timeout=90_000,
        )
        completed_joint = scene_joint(page, "right_J1")
        assert abs(completed_joint + 20) < 0.001
        final_pose = scene_pose(page)
        assert abs(final_pose["x"] - second_stop_pose["x"]) < 0.001
        assert abs(final_pose["y"] - second_stop_pose["y"]) < 0.001
        assert_following(followed_view, scene_view(page))
        loop_boundary = page.wait_for_function(
            """() => {
              const dock = document.querySelector('.teaching-playback-dock');
              const canvas = document.querySelector('.three-canvas');
              if (Number(dock?.dataset.playbackCycle) < 2 || !canvas) return false;
              return {
                ...dock.dataset,
                x: Number(canvas.dataset.robotX),
                joint: JSON.parse(canvas.dataset.robotJointValues).right_J1,
              };
            }""",
            timeout=30_000,
        ).json_value()
        assert loop_boundary["playbackStatus"] == "playing"
        assert loop_boundary["playbackCycle"] == "2"
        assert loop_boundary["playbackSpeed"] == "2"
        assert loop_boundary["playbackReachedPose"] == "1/3"
        assert loop_boundary["playbackPhase"] == "hold"
        assert loop_boundary["playbackPose"] == "1/3"
        assert loop_boundary["playbackTotalMs"] == start_snapshot["playbackTotalMs"]
        assert abs(loop_boundary["x"]) < 0.001
        assert abs(loop_boundary["joint"]) < 0.001
        assert loop_boundary["followRobot"] == "true"
        assert_following(followed_view, scene_view(page))
        assert page.locator(".point-cloud-view").get_attribute("data-robot-trajectory-active") == "true"
        assert viewer_tool(page, name="定位机器人模型").is_disabled()

        # Turning following off freezes the camera while the robot keeps moving.
        follow_switch.press("Space")
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotFollowEnabled === 'false'"
        )
        assert follow_switch.get_attribute("aria-checked") == "false"
        fixed_view = scene_view(page)
        page.wait_for_function(
            """() => {
              const dock = document.querySelector('.teaching-playback-dock');
              const canvas = document.querySelector('.three-canvas');
              return dock?.dataset.playbackCycle === '2'
                && dock.dataset.playbackPhase === 'chassis'
                && Number(canvas?.dataset.robotX) > 0.025;
            }""",
            timeout=30_000,
        )
        moved_view = scene_view(page)
        assert moved_view["robot"][0] > fixed_view["robot"][0] + 0.02
        for key in ("camera", "target", "up", "zoom"):
            assert moved_view[key] == fixed_view[key], (key, fixed_view, moved_view)

        # Following can be re-enabled mid-motion and survives a collapsed dock
        # and the jump back to the first recording on the next cycle.
        follow_switch.evaluate("element => element.click()")
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotFollowEnabled === 'true'"
        )
        resumed_follow_view = scene_view(page)
        page.get_by_role("button", name="向左收起播放控制条").click()
        page.wait_for_function(
            "Number(document.querySelector('.teaching-playback-dock')?.dataset.playbackCycle) >= 3",
            timeout=30_000,
        )
        assert dock.get_attribute("data-collapsed") == "true"
        assert dock.get_attribute("data-playback-status") == "playing"
        assert dock.get_attribute("data-follow-robot") == "true"
        assert_following(resumed_follow_view, scene_view(page))
        page.get_by_role("button", name="展开播放控制条").click()
        assert follow_switch.get_attribute("aria-checked") == "true"
        page.get_by_role("button", name="停止示教轨迹播放").click()
        dock.wait_for(state="detached")
        assert page.locator(".point-cloud-view").get_attribute(
            "data-robot-trajectory-active"
        ) == "false"
        stopped_pose = scene_pose(page)
        stopped_joint = scene_joint(page, "right_J1")
        stopped_view = scene_view(page)
        assert page.locator(".three-canvas").get_attribute("data-robot-follow-enabled") == "false"
        page.wait_for_timeout(700)
        assert scene_pose(page) == stopped_pose
        assert scene_joint(page, "right_J1") == stopped_joint
        assert scene_view(page) == stopped_view
        assert viewer_tool(page, name="定位机器人模型").is_enabled()

        page.screenshot(path="/tmp/atlas-teaching-playback.png", full_page=True)
        assert not errors, errors
        print("pose_count=3")
        print("start_snapshot=", start_snapshot)
        print("paused_joint=", round(paused_joint, 4))
        print("completed_joint=", round(completed_joint, 4))
        print("loop_boundary=", loop_boundary)
        print("page_errors=", errors)
        browser.close()


if __name__ == "__main__":
    run()
