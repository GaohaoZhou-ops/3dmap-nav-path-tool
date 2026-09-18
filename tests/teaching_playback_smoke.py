import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


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
              project.robot.origin = pose(0.12);
              project.robot.joints = { ...baseJoints, right_J1: -20 };
              record.config.ui.activeTeachingTaskId = task.id;
              record.config.ui.activeTeachingParkingPointId = 'playback-stop-2';
              await new Promise((resolve, reject) => {
                const transaction = database.transaction('workspace-session', 'readwrite');
                transaction.objectStore('workspace-session').put(record);
                transaction.oncomplete = resolve;
                transaction.onerror = () => reject(transaction.error);
              });
              database.close();
              return { secondStopPose: pose(0.12), rightJoint: -20 };
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
            "Math.abs(JSON.parse(document.querySelector('.three-canvas')?.dataset.robotJointValues || '{}').right_J1 + 20) < 0.001"
        )
        second_stop_pose = {
            **fixture["secondStopPose"]["position"],
            **fixture["secondStopPose"]["rpy"],
        }

        page.get_by_role("button", name="打开示教数据管理页").click()
        page.locator('[data-app-page="teaching-data"]').wait_for()
        page.get_by_role("button", name="选择示教任务 轨迹回放验证").click()
        play_task = page.get_by_role("button", name="播放示教任务 轨迹回放验证")
        assert play_task.is_enabled()
        play_task.click()

        page.locator('[data-app-page="teaching-data"]').wait_for(state="detached")
        assert page.url.rstrip("/") == f"{BASE_URL.rstrip('/')}/workbench"
        dock = page.get_by_label("示教任务轨迹播放控制", exact=True)
        dock.wait_for()
        assert dock.get_attribute("data-playback-status") == "playing"
        assert dock.get_attribute("data-playback-task")
        assert dock.get_attribute("data-playback-pose").endswith("/3")
        assert page.locator(".point-cloud-view").get_attribute(
            "data-robot-trajectory-active"
        ) == "true"
        assert page.get_by_role("button", name="定位机器人模型").is_disabled()
        page.get_by_role("combobox", name="示教轨迹播放速度").select_option("0.5")
        page.wait_for_timeout(700)
        page.screenshot(path="/tmp/atlas-teaching-playback-active.png", full_page=True)

        page.wait_for_function(
            """
            () => {
              const dock = document.querySelector('[aria-label="示教任务轨迹播放控制"]');
              const canvas = document.querySelector('.three-canvas');
              if (dock?.dataset.playbackPhase !== 'joints' || !canvas) return false;
              const ordinal = Number((dock.dataset.playbackPose || '').split('/')[0]);
              const value = Number(JSON.parse(canvas.dataset.robotJointValues || '{}').right_J1);
              const ranges = { 1: [-20, 0], 2: [0, 30], 3: [-20, 30] };
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

        page.get_by_role("combobox", name="示教轨迹播放速度").select_option("2")
        page.get_by_role("button", name="继续示教轨迹播放").click()
        print(
            "playback_plan=",
            dock.get_attribute("data-playback-segment"),
            dock.get_attribute("data-playback-elapsed-ms"),
            dock.get_attribute("data-playback-total-ms"),
            dock.get_attribute("data-playback-speed"),
            flush=True,
        )
        page.wait_for_function(
            "document.querySelector('[aria-label=\"示教任务轨迹播放控制\"]')?.dataset.playbackStatus === 'completed'",
            timeout=90_000,
        )
        completed_joint = scene_joint(page, "right_J1")
        assert abs(completed_joint + 20) < 0.001
        final_pose = scene_pose(page)
        assert abs(final_pose["x"] - second_stop_pose["x"]) < 0.001
        assert abs(final_pose["y"] - second_stop_pose["y"]) < 0.001
        assert page.locator(".point-cloud-view").get_attribute(
            "data-robot-trajectory-active"
        ) == "false"
        assert page.get_by_role("button", name="定位机器人模型").is_enabled()

        page.get_by_role("button", name="重新播放当前示教任务").click()
        page.wait_for_function(
            "document.querySelector('[aria-label=\"示教任务轨迹播放控制\"]')?.dataset.playbackStatus === 'playing'"
        )
        page.get_by_role("button", name="停止示教轨迹播放").click()
        dock.wait_for(state="detached")
        assert page.locator(".point-cloud-view").get_attribute(
            "data-robot-trajectory-active"
        ) == "false"

        page.screenshot(path="/tmp/atlas-teaching-playback.png", full_page=True)
        assert not errors, errors
        print("pose_count=3")
        print("paused_joint=", round(paused_joint, 4))
        print("completed_joint=", round(completed_joint, 4))
        print("page_errors=", errors)
        browser.close()


if __name__ == "__main__":
    run()
