import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

from archive_helpers import read_exported_project


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
        teaching_tab.click()
        assert teaching_tab.get_attribute("aria-selected") == "true"
        assert page.get_by_label("全关节控制浮动窗口", exact=True).count() == 0
        teaching_panel = page.get_by_label("虚拟示教", exact=True)
        new_task = page.get_by_role("button", name="新建示教任务", exact=True)
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
        create_dialog = page.get_by_role("dialog", name="新建示教任务")
        create_dialog.wait_for()
        task_name_input = create_dialog.get_by_role("textbox", name="新示教任务名称")
        assert task_name_input.input_value() == "示教任务 01"
        task_name_input.fill("双臂装配演示（新建）")
        parking_option = create_dialog.get_by_role("button", name="添加当前位置为停车点")
        assert parking_option.get_attribute("aria-pressed") == "false"
        page.screenshot(path="/tmp/atlas-teaching-task-create.png", full_page=True)
        create_dialog.get_by_role("button", name="创建任务", exact=True).click()
        page.wait_for_function(
            "document.querySelector('[aria-label=\"虚拟示教\"]')?.dataset.teachingTaskCount === '1'"
        )
        assert teaching_panel.get_attribute("data-teaching-context-match") == "true"
        assert teaching_panel.get_attribute("data-camera-inverse-mode") == "automatic"
        assert teaching_panel.get_attribute("data-parking-point-count") == "0"
        capture_tree_card = page.get_by_label("示教任务与停车点树", exact=True)
        assert capture_tree_card.is_visible()
        assert capture_tree_card.get_by_role("tree", name="虚拟示教任务停车点层级").is_visible()
        assert page.get_by_role("button", name="打开示教任务 双臂装配演示（新建）").is_visible()
        assert capture_tree_card.locator(".teaching-capture-tree__parking").count() == 0
        assert page.locator(".teaching-context").count() == 0
        assert page.get_by_role("tab", name="相机反算", exact=True).count() == 0
        assert page.get_by_label("自碰撞保护", exact=True).count() == 0
        assert page.get_by_role("button", name="记录当前机械臂姿态").is_disabled()

        page.get_by_role("button", name="新增停车点", exact=True).click()
        page.wait_for_function(
            "document.querySelector('[aria-label=\"虚拟示教\"]')?.dataset.parkingPointCount === '1'"
        )
        first_parking_node = capture_tree_card.get_by_role(
            "treeitem", name="选择当前停车点 停车点 P01"
        )
        assert first_parking_node.is_visible()
        assert first_parking_node.get_attribute("aria-current") == "true"

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

        page.get_by_role("button", name="记录当前机械臂姿态").click()
        page.wait_for_function(
            "document.querySelector('[aria-label=\"虚拟示教\"]')?.dataset.teachingPointCount === '1'"
        )
        assert page.get_by_role("button", name="新建示教任务", exact=True).is_visible()
        assert page.get_by_label("示教任务与停车点树", exact=True).is_visible()
        assert page.get_by_role("button", name="新增停车点", exact=True).is_visible()
        assert page.get_by_role("button", name="记录当前机械臂姿态", exact=True).is_visible()
        assert page.get_by_text("当前已归档姿态", exact=True).count() == 0
        assert page.locator(".teaching-data-handoff").count() == 0
        assert page.get_by_role("button", name="打开示教数据管理页").is_visible()
        assert page.locator(".teaching-point-row").count() == 0
        page.screenshot(path="/tmp/atlas-virtual-teaching-capture.png", full_page=True)

        page.get_by_role("button", name="打开示教数据管理页").click()
        page.locator('[data-app-page="teaching-data"]').wait_for()
        assert page.url.endswith("/teaching-data")
        data_panel = page.locator('section[aria-label="示教数据管理"]')
        assert data_panel.get_attribute("data-teaching-view") == "data"
        assert page.get_by_role("tree", name="任务停车点与机械臂姿态").is_visible()
        assert page.get_by_text(
            "按“任务 → 停车点 → 机械臂姿态”管理全身关节与双目视觉快照；实时采集留在主工作台。",
            exact=True,
        ).count() == 0
        assert page.get_by_text("采集与管理分离", exact=True).count() == 0
        page.get_by_role("button", name="选择示教任务 双臂装配演示（新建）").click()
        task_name = page.get_by_role("textbox", name="示教任务名称")
        assert task_name.input_value() == "双臂装配演示（新建）"
        task_name.fill("双臂装配演示")
        task_name.press("Enter")
        page.get_by_role("button", name="选择停车点 停车点 P01").click()
        parking_map = page.get_by_label("停车点二维地图位置", exact=True)
        parking_map.wait_for()
        assert parking_map.get_attribute("data-map-ready") == "true"
        vector_layer = parking_map.get_by_label("二维矢量点云截面", exact=True)
        vector_layer.wait_for()
        assert int(vector_layer.get_attribute("data-source-point-count")) > 0
        parking_values = page.get_by_label("停车点地图位姿", exact=True)
        assert parking_values.locator(":scope > div").count() == 6
        assert len(parking_values.evaluate("node => getComputedStyle(node).gridTemplateColumns.split(' ')")) == 6
        map_view = parking_map.locator(".map2d-view")
        page.wait_for_function(
            "node => node.dataset.synchronizedFocusState === 'settled'",
            arg=map_view.element_handle(),
        )
        initial_map_scale = float(map_view.get_attribute("data-view-scale"))
        parking_map.get_by_role("button", name="放大", exact=True).click()
        page.wait_for_function(
            "scale => Number(document.querySelector('.teaching-parking-map .map2d-view')?.dataset.viewScale) > scale",
            arg=initial_map_scale,
        )
        page.get_by_role("button", name="查看机械臂姿态 A01").click()
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

        point_name = page.get_by_role("textbox", name="机械臂姿态名称")
        point_name.fill("抓取准备位")
        point_name.press("Enter")

        page.get_by_role("button", name="返回主工作台继续示教").click()
        page.locator('[data-app-page="teaching-data"]').wait_for(state="detached")
        teaching_tab.click()
        assert page.get_by_label("全关节控制浮动窗口", exact=True).count() == 0
        page.get_by_role("button", name="记录当前机械臂姿态").click()
        page.wait_for_function(
            "document.querySelector('[aria-label=\"虚拟示教\"]')?.dataset.teachingPointCount === '2'"
        )
        page.keyboard.press("w")
        page.keyboard.press("d")
        page.wait_for_timeout(160)
        second_pose = read_pose(canvas)
        assert abs(second_pose["x"] - first_pose["x"]) > 0.04
        record_pose = page.get_by_role("button", name="记录当前机械臂姿态")
        record_pose.click()
        drift_dialog = page.get_by_role("dialog", name="底盘已移动")
        drift_dialog.wait_for()
        assert drift_dialog.get_by_text("底盘已移动，是否新建停车点？", exact=True).is_visible()
        assert float(drift_dialog.get_attribute("data-planar-distance")) >= 0.05
        assert float(drift_dialog.get_attribute("data-distance-threshold")) == 0.05
        assert float(drift_dialog.get_attribute("data-yaw-threshold")) == 5
        assert teaching_panel.get_attribute("data-parking-point-count") == "1"
        assert teaching_panel.get_attribute(
            "data-teaching-point-count"
        ) == "2"

        page.keyboard.press("Escape")
        drift_dialog.wait_for(state="detached")
        assert teaching_panel.get_attribute("data-parking-point-count") == "1"
        record_pose.click()
        drift_dialog.wait_for()
        page.screenshot(path="/tmp/atlas-teaching-parking-drift.png", full_page=True)
        drift_dialog.get_by_role(
            "button", name="新建停车点并记录当前姿态"
        ).click()
        page.wait_for_function(
            "document.querySelector('[aria-label=\"虚拟示教\"]')?.dataset.parkingPointCount === '2'"
        )
        page.wait_for_function(
            "document.querySelector('[aria-label=\"虚拟示教\"]')?.dataset.teachingPointCount === '3'"
        )
        drift_dialog.wait_for(state="detached")
        second_parking_node = page.get_by_label("示教任务与停车点树", exact=True).get_by_role(
            "treeitem", name="选择当前停车点 停车点 P02"
        )
        assert second_parking_node.get_attribute("aria-current") == "true"
        assert teaching_panel.get_attribute("data-parking-point-count") == "2"

        page.get_by_role("button", name="打开示教数据管理页").click()
        page.locator('[data-app-page="teaching-data"]').wait_for()
        page.wait_for_function("document.querySelectorAll('.teaching-tree-node--parking').length === 2")
        assert page.locator(".teaching-point-row").count() == 1
        assert page.get_by_role("textbox", name="机械臂姿态名称").input_value() == "A01"

        page.get_by_role("button", name="展开停车点 停车点 P01").click()
        assert page.locator(".teaching-point-row").count() == 3
        page.get_by_role("button", name="折叠停车点 停车点 P01").click()
        assert page.locator(".teaching-point-row").count() == 1

        page.get_by_role("button", name="选择停车点 停车点 P01").click()
        page.get_by_role("button", name="查看机械臂姿态 抓取准备位").click()
        page.get_by_role("button", name="应用到机器人", exact=True).click()
        page.wait_for_function(
            "([x, y, yaw]) => { const d = document.querySelector('.three-canvas')?.dataset; return d && Math.abs(Number(d.robotX)-x)<1e-5 && Math.abs(Number(d.robotY)-y)<1e-5 && Math.abs(Number(d.robotYaw)-yaw)<1e-5; }",
            arg=[first_pose["x"], first_pose["y"], first_pose["yaw"]],
        )
        assert_pose_close(read_pose(canvas), first_pose)
        assert canvas.get_attribute("data-robot-control-enabled") == "false"

        with page.expect_download() as download_info:
            page.get_by_role("button", name="导出示教工程 ZIP").click()
        exported = read_exported_project(download_info.value)
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
        assert len(task["parkingPoints"]) == 2
        assert [parking["sequence"] for parking in task["parkingPoints"]] == [1, 2]
        assert [len(parking["poses"]) for parking in task["parkingPoints"]] == [2, 1]
        assert task["parkingPoints"][0]["poses"][0]["name"] == "抓取准备位"
        assert task["parkingPoints"][0]["poses"][1]["name"] == "A02"
        assert task["parkingPoints"][1]["poses"][0]["name"] == "A01"
        first_export = task["parkingPoints"][0]["poses"][0]
        assert first_export["mapPose"]["frameId"] == "map"
        assert abs(first_export["mapPose"]["position"]["x"] - first_pose["x"]) < 1e-5
        assert abs(first_export["mapPose"]["rpy"]["yaw"] - first_pose["yaw"]) < 1e-5
        assert first_export["fullBodyJoints"]["count"] == movable_joint_count
        assert len(first_export["fullBodyJoints"]["values"]) == movable_joint_count
        assert abs(task["parkingPoints"][1]["mapPose"]["position"]["x"] - second_pose["x"]) < 1e-5

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
        assert len(stored_tasks[0]["parkingPoints"]) == 2
        assert [len(item["poses"]) for item in stored_tasks[0]["parkingPoints"]] == [2, 1]

        page.reload(wait_until="domcontentloaded")
        page.locator(".teaching-data-page__session.is-ready").wait_for()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        teaching_panel = page.locator('section[aria-label="示教数据管理"]')
        assert teaching_panel.get_attribute("data-teaching-task-count") == "1"
        assert teaching_panel.get_attribute("data-parking-point-count") == "2"
        assert teaching_panel.get_attribute("data-teaching-context-match") == "true"
        page.get_by_role("button", name="选择示教任务 双臂装配演示").click()
        assert page.get_by_role("textbox", name="示教任务名称").input_value() == "双臂装配演示"
        assert page.locator(".teaching-tree-node--parking").count() == 2
        page.get_by_role("button", name="选择停车点 停车点 P01").click()
        page.wait_for_function("document.querySelectorAll('.teaching-point-row').length >= 2")
        assert page.get_by_role("button", name="查看机械臂姿态 抓取准备位").is_visible()
        assert page.get_by_role("button", name="查看机械臂姿态 A02").is_visible()
        page.get_by_role("button", name="选择停车点 停车点 P02").click()
        assert page.get_by_role("button", name="查看机械臂姿态 A01").is_visible()
        assert page.locator(".session-guard").get_attribute("data-session-restored") == "true"

        page.get_by_role("button", name="选择示教任务 双臂装配演示").click()
        merge_button = page.get_by_role(
            "button", name="分析并合并当前任务的近邻停车点"
        )
        assert merge_button.is_enabled()
        merge_button.click()
        merge_dialog = page.get_by_role("dialog", name="合并停车点")
        merge_dialog.wait_for()
        page.wait_for_function(
            "document.querySelector('.parking-merge-modal')?.dataset.analysisStatus === 'ready'",
            timeout=180_000,
        )
        assert merge_dialog.get_by_role(
            "spinbutton", name="停车点近邻聚类半径"
        ).input_value() == "0.35"
        assert merge_dialog.get_by_role(
            "spinbutton", name="融合后末端XYZ容差"
        ).input_value() == "5"
        assert merge_dialog.get_by_role(
            "spinbutton", name="融合后末端RPY容差"
        ).input_value() == "5"
        assert merge_dialog.get_attribute("data-cluster-count") == "1"
        cluster = merge_dialog.locator("[data-merge-cluster-id]").first
        assert cluster.get_attribute("data-merge-member-count") == "2"
        assert cluster.get_attribute("data-merge-pose-count") == "3"
        assert cluster.get_attribute("data-merge-feasible") == "true"
        assert merge_dialog.get_attribute("data-selected-cluster-count") == "1"
        assert merge_dialog.get_by_label("近邻簇 1 公共停车点位姿").is_visible()
        page.screenshot(path="/tmp/atlas-parking-point-merge-analysis.png", full_page=True)

        xyz_tolerance = merge_dialog.get_by_role(
            "spinbutton", name="融合后末端XYZ容差"
        )
        xyz_tolerance.fill("6")
        assert merge_dialog.get_by_text(
            "容差参数已经修改，请重新分析后再执行合并。", exact=True
        ).is_visible()
        confirm_merge = merge_dialog.get_by_role(
            "button", name="确认合并选中的停车点"
        )
        assert confirm_merge.is_disabled()
        merge_dialog.get_by_role(
            "button", name="使用当前容差重新分析"
        ).click()
        page.wait_for_function(
            "document.querySelector('.parking-merge-modal')?.dataset.analysisStatus === 'ready'",
            timeout=180_000,
        )
        assert merge_dialog.get_attribute("data-feasible-cluster-count") == "1"
        confirm_merge = merge_dialog.get_by_role(
            "button", name="确认合并选中的停车点"
        )
        assert confirm_merge.is_enabled()
        confirm_merge.click()
        merge_dialog.wait_for(state="detached")
        page.wait_for_function(
            "document.querySelector('[aria-label="
            "\"示教数据管理\"]')?.dataset.parkingPointCount === '1'"
        )
        assert page.locator(".teaching-tree-node--parking").count() == 1

        with page.expect_download() as merged_download_info:
            page.get_by_role("button", name="导出示教工程 ZIP").click()
        merged_export = read_exported_project(merged_download_info.value)
        merged_task = merged_export["virtualTeaching"]["tasks"][0]
        assert len(merged_task["parkingPoints"]) == 1
        merged_parking = merged_task["parkingPoints"][0]
        assert len(merged_parking["poses"]) == 3
        assert len(merged_parking["mergeHistory"]) == 1
        assert len(merged_parking["mergeHistory"][0]["sourceParkingPoints"]) == 2
        assert merged_parking["mergeHistory"][0]["positionTolerance"] == 0.06
        for merged_pose in merged_parking["poses"]:
            assert len(merged_pose["replanningHistory"]) == 1
            assert merged_pose["mapPose"] == merged_parking["mapPose"]
            assert merged_pose["fullBodyJoints"]["count"] == movable_joint_count
            assert set(merged_pose["cameraCapture"]["frames"]) == {"left", "right"}

        page.wait_for_timeout(550)
        page.reload(wait_until="domcontentloaded")
        page.locator(".teaching-data-page__session.is-ready").wait_for()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        data_panel = page.locator('section[aria-label="示教数据管理"]')
        assert data_panel.get_attribute("data-parking-point-count") == "1"
        assert data_panel.get_attribute("data-teaching-point-count") == "3"
        page.get_by_role("button", name="选择示教任务 双臂装配演示").click()
        assert page.locator(".teaching-tree-node--parking").count() == 1

        with page.expect_download() as restored_download_info:
            page.get_by_role("button", name="导出示教工程 ZIP").click()
        restored_export = read_exported_project(restored_download_info.value)
        restored_parking = restored_export["virtualTeaching"]["tasks"][0]["parkingPoints"][0]
        assert len(restored_parking["mergeHistory"]) == 1
        assert all(
            len(pose["replanningHistory"]) == 1 for pose in restored_parking["poses"]
        )

        page.screenshot(path="/tmp/atlas-virtual-teaching.png", full_page=True)
        print("teaching_task=", merged_task["name"])
        print("parking_points=", len(merged_task["parkingPoints"]))
        print("teaching_poses=", sum(len(item["poses"]) for item in merged_task["parkingPoints"]))
        print("parking_merge_history=", len(merged_parking["mergeHistory"]))
        print("movable_joints=", movable_joint_count)
        print("page_errors=", errors)
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
