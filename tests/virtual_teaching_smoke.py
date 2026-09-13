import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:22060")
ROOT = Path(__file__).resolve().parents[1]


def read_pose(canvas):
    return {
        name: float(canvas.get_attribute(f"data-robot-{name}"))
        for name in ("x", "y", "z", "roll", "pitch", "yaw")
    }


def assert_pose_close(actual, expected, tolerance=1e-5):
    for name, value in expected.items():
        assert abs(actual[name] - value) < tolerance, (name, actual[name], value)


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(180_000)
        page.on("pageerror", lambda error: errors.append(str(error)))

        page.goto(BASE_URL, wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        teaching_tab = page.get_by_role("tab", name="虚拟示教与相机")
        teaching_data_tab = page.get_by_role("tab", name="示教数据管理")
        teaching_tab.click()
        assert teaching_tab.get_attribute("aria-selected") == "true"
        page.get_by_role("button", name="隐藏全关节浮动窗口").click()
        teaching_panel = page.get_by_label("虚拟示教", exact=True)
        new_task = page.get_by_role("button", name="新建任务", exact=True)
        assert new_task.is_disabled()

        page.locator('input[type="file"][accept=".ply"]').set_input_files(
            str(ROOT / "tests/fixtures/rotation-map.ply")
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        assert new_task.is_disabled()

        page.get_by_role("button", name="加载机器人", exact=True).click()
        page.get_by_role("option", name="加载机器人 botx_abx_zivid_m70").click()
        canvas = page.locator(".three-canvas")
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )
        page.wait_for_function(
            "Number(document.querySelector('[aria-label=\"虚拟示教\"]')?.dataset.currentJointCount) > 0"
        )
        assert not new_task.is_disabled()
        movable_joint_count = int(teaching_panel.get_attribute("data-current-joint-count"))
        assert movable_joint_count > 0

        new_task.click()
        page.wait_for_function(
            "document.querySelector('[aria-label=\"虚拟示教\"]')?.dataset.teachingTaskCount === '1'"
        )
        assert teaching_panel.get_attribute("data-teaching-context-match") == "true"
        assert "rotation-map.ply" in page.locator(".teaching-context").inner_text()
        assert "botx_abx_zivid_m70" in page.locator(".teaching-context").inner_text()

        robot_button = page.get_by_role("button", name="定位机器人模型")
        robot_button.click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotControlEnabled === 'true'"
        )
        page.keyboard.press("w")
        page.keyboard.press("a")
        page.keyboard.press("ArrowLeft")
        page.wait_for_function(
            "Number(document.querySelector('.three-canvas')?.dataset.robotX) > 0.04"
        )
        first_pose = read_pose(canvas)
        assert first_pose["y"] > 0.04
        assert first_pose["yaw"] > 4

        page.get_by_role("button", name="记录当前机器人姿态").click()
        page.wait_for_function(
            "document.querySelector('.teaching-data-handoff')?.dataset.teachingPointCount === '1'"
        )
        assert page.locator(".teaching-point-row").count() == 0

        page.get_by_role("button", name="管理数据", exact=False).click()
        assert teaching_data_tab.get_attribute("aria-selected") == "true"
        data_panel = page.locator('section[aria-label="示教数据管理"]')
        assert data_panel.get_attribute("data-teaching-view") == "data"
        task_name = page.get_by_role("textbox", name="示教任务名称")
        task_name.fill("双臂装配演示")
        task_name.press("Enter")
        first_row = page.locator(".teaching-point-row").first
        first_row.wait_for()
        assert first_row.get_attribute("data-joint-count") == str(movable_joint_count)
        detail = page.locator(".teaching-point-detail")
        detail.wait_for()
        captured_first_pose = {
            "x": float(detail.get_attribute("data-map-x")),
            "y": float(detail.get_attribute("data-map-y")),
            "z": float(detail.get_attribute("data-map-z")),
            "roll": float(detail.get_attribute("data-map-roll")),
            "pitch": float(detail.get_attribute("data-map-pitch")),
            "yaw": float(detail.get_attribute("data-map-yaw")),
        }
        assert_pose_close(captured_first_pose, first_pose)
        assert page.locator(".teaching-joint-list > div").count() == movable_joint_count

        point_name = page.get_by_role("textbox", name="示教点名称")
        point_name.fill("抓取准备位")
        point_name.press("Enter")

        teaching_tab.click()
        page.get_by_role("button", name="隐藏全关节浮动窗口").click()
        page.keyboard.press("w")
        page.keyboard.press("d")
        page.wait_for_timeout(160)
        second_pose = read_pose(canvas)
        assert abs(second_pose["x"] - first_pose["x"]) > 0.04
        page.get_by_role("button", name="记录当前机器人姿态").click()
        page.wait_for_function(
            "document.querySelector('.teaching-data-handoff')?.dataset.teachingPointCount === '2'"
        )

        teaching_data_tab.click()
        page.wait_for_function("document.querySelectorAll('.teaching-point-row').length === 2")
        assert page.get_by_role("textbox", name="示教点名称").input_value() == "T02"

        page.get_by_role("button", name="查看示教点 抓取准备位").click()
        page.get_by_role("button", name="应用到机器人", exact=True).click()
        page.wait_for_function(
            "([x, y, yaw]) => { const d = document.querySelector('.three-canvas')?.dataset; return d && Math.abs(Number(d.robotX)-x)<1e-5 && Math.abs(Number(d.robotY)-y)<1e-5 && Math.abs(Number(d.robotYaw)-yaw)<1e-5; }",
            arg=[first_pose["x"], first_pose["y"], first_pose["yaw"]],
        )
        assert_pose_close(read_pose(canvas), first_pose)
        assert canvas.get_attribute("data-robot-control-enabled") == "false"

        with page.expect_download() as download_info:
            page.get_by_role("button", name="导出示教工程 JSON").click()
        exported = json.loads(Path(download_info.value.path()).read_text())
        teaching = exported["virtualTeaching"]
        assert teaching["coordinateFrame"] == "map"
        assert teaching["angularUnit"] == "degree"
        assert teaching["distanceUnit"] == "meter"
        assert len(teaching["tasks"]) == 1
        task = teaching["tasks"][0]
        assert task["name"] == "双臂装配演示"
        assert task["map"]["fileName"] == "rotation-map.ply"
        assert task["map"]["sourceHash"]
        assert task["robot"]["relativePath"].endswith("botx_abx_zivid_m70.urdf")
        assert [point["name"] for point in task["points"]] == ["抓取准备位", "T02"]
        assert [point["sequence"] for point in task["points"]] == [1, 2]
        first_export = task["points"][0]
        assert first_export["mapPose"]["frameId"] == "map"
        assert abs(first_export["mapPose"]["position"]["x"] - first_pose["x"]) < 1e-5
        assert abs(first_export["mapPose"]["rpy"]["yaw"] - first_pose["yaw"]) < 1e-5
        assert first_export["fullBodyJoints"]["count"] == movable_joint_count
        assert len(first_export["fullBodyJoints"]["values"]) == movable_joint_count

        page.wait_for_timeout(550)
        stored_tasks = page.evaluate(
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
              return record?.config?.project?.virtualTeaching?.tasks || [];
            }
            """
        )
        assert len(stored_tasks) == 1
        assert len(stored_tasks[0]["points"]) == 2

        page.reload(wait_until="domcontentloaded")
        page.locator('[data-session-state="ready"]').wait_for()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.get_by_role("tab", name="示教数据管理").click(force=True)
        teaching_panel = page.locator('section[aria-label="示教数据管理"]')
        assert teaching_panel.get_attribute("data-teaching-task-count") == "1"
        assert teaching_panel.get_attribute("data-teaching-context-match") == "true"
        assert page.get_by_role("textbox", name="示教任务名称").input_value() == "双臂装配演示"
        assert page.locator(".teaching-point-row").count() == 2
        assert page.get_by_role("button", name="查看示教点 抓取准备位").is_visible()
        assert page.get_by_role("button", name="查看示教点 T02").is_visible()
        assert page.locator(".session-guard").get_attribute("data-session-restored") == "true"

        page.screenshot(path="/tmp/atlas-virtual-teaching.png", full_page=True)
        print("teaching_task=", task["name"])
        print("teaching_points=", len(task["points"]))
        print("movable_joints=", movable_joint_count)
        print("page_errors=", errors)
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
