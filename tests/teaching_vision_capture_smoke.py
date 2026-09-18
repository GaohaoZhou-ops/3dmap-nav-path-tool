import base64
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

from archive_helpers import read_exported_archive


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:22083")
ROOT = Path(__file__).resolve().parents[1]


def assert_camera_capture(capture):
    assert capture["status"] == "complete"
    assert capture["cameraModel"] == "Zivid 2 M70"
    assert capture["imageResolution"] == [640, 395]
    assert capture["calibration"]["nativeResolution"] == [1944, 1200]
    assert capture["calibration"]["horizontalFov"] == 56.6
    assert capture["calibration"]["verticalFov"] == 35.6
    assert capture["storageByteLength"] > 0
    assert set(capture["frames"]) == {"left", "right"}
    for side, frame in capture["frames"].items():
        assert frame["side"] == side
        assert frame["opticalPose"]["frameName"] == f"zivid_{side}_optical_frame"
        assert frame["rgb"]["dataUrl"].startswith("data:image/")
        assert frame["rgb"]["width"] == 640
        assert frame["rgb"]["height"] == 395
        cloud = frame["pointCloud"]
        assert cloud["coordinateFrame"] == f"zivid_{side}_optical_frame"
        assert cloud["convention"] == "x-right/y-down/z-forward"
        assert cloud["positionEncoding"] == "uint16-le/base64"
        assert cloud["colorEncoding"] == "rgb8/base64"
        assert cloud["visiblePointCount"] >= cloud["pointCount"]
        if cloud["pointCount"]:
            assert cloud["positionData"]
            assert cloud["colorData"]
            assert len(base64.b64decode(cloud["positionData"])) == cloud["pointCount"] * 6
            assert len(base64.b64decode(cloud["colorData"])) == cloud["pointCount"] * 3
        assert cloud["preview"]["dataUrl"].startswith("data:image/")


def run():
    page_errors = []
    console_errors = []
    failed_responses = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1500, "height": 940})
        page.set_default_timeout(180_000)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "response",
            lambda response: failed_responses.append(
                f"{response.status} {response.url}"
            )
            if response.status >= 400
            else None,
        )
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )

        page.goto(f"{BASE_URL.rstrip('/')}/workbench", wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator('input[type="file"][accept=".ply"]').set_input_files(
            str(ROOT / "tests/fixtures/hybrid-camera-surface-map.ply")
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.get_by_role("button", name="加载机器人", exact=True).click()
        page.get_by_role("option", name="加载机器人 botx_abx_zivid_m70").click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )

        page.get_by_role("tab", name="虚拟示教与相机").click()
        assert page.get_by_label("全关节控制浮动窗口", exact=True).count() == 0
        page.wait_for_function(
            "document.querySelector('.zivid-camera-canvas')?.dataset.contextState === 'ready'"
        )
        page.get_by_role("button", name="新建示教任务", exact=True).click()
        create_dialog = page.get_by_role("dialog", name="新建示教任务")
        create_dialog.get_by_role("textbox", name="新示教任务名称").fill("双目视觉采集")
        parking_option = create_dialog.get_by_role("button", name="添加当前位置为停车点")
        parking_option.click()
        assert parking_option.get_attribute("aria-pressed") == "true"
        create_dialog.get_by_role("button", name="创建任务", exact=True).click()
        capture_button = page.get_by_role("button", name="记录当前机械臂姿态")
        capture_button.click()
        teaching_panel = page.get_by_label("虚拟示教", exact=True)
        page.wait_for_function(
            "document.querySelector('[aria-label=\"虚拟示教\"]')?.dataset.cameraCaptureStatus === 'complete'",
            timeout=180_000,
        )
        assert capture_button.get_attribute("aria-busy") == "false"

        page.get_by_role("button", name="打开示教数据管理页").click()
        page.locator('[data-app-page="teaching-data"]').wait_for()
        assert page.url.endswith("/teaching-data")
        assert page.locator('section[aria-label="示教数据管理"]').is_visible()
        point_row = page.locator(".teaching-point-row").first
        assert int(point_row.get_attribute("data-joint-count")) == 24
        assert point_row.get_attribute("data-camera-frame-count") == "2"
        vision = page.get_by_label("机械臂姿态双目视觉快照", exact=True)
        assert vision.get_attribute("data-camera-frame-count") == "2"
        assert vision.get_attribute("data-camera-model") == "Zivid 2 M70"
        frames = vision.locator(".teaching-vision-frame")
        assert frames.count() == 2
        point_counts = [
            int(frames.nth(index).get_attribute("data-point-count"))
            for index in range(frames.count())
        ]
        assert max(point_counts) > 0
        thumbnails = vision.locator(".teaching-vision-thumbnails img")
        assert thumbnails.count() == 4
        for index in range(thumbnails.count()):
            assert thumbnails.nth(index).get_attribute("src").startswith("data:image/")

        page.get_by_role("button", name="查看 A01 左臂RGB 快照").click()
        modal = page.get_by_role("dialog", name="示教视觉快照大图")
        modal.wait_for()
        assert modal.locator("img").get_attribute("src").startswith("data:image/")
        page.screenshot(path="/tmp/atlas-teaching-vision-preview.png", full_page=True)
        page.get_by_role("button", name="关闭示教视觉快照").click()
        modal.wait_for(state="detached")

        page.get_by_role("button", name="查看 A01 左臂XYZ 快照").click()
        modal = page.get_by_role("dialog", name="示教视觉快照大图")
        modal.wait_for()
        assert "XYZ POINTS" in modal.inner_text()
        page.get_by_role("button", name="关闭示教视觉快照").click()
        modal.wait_for(state="detached")

        with page.expect_download() as download_info:
            page.get_by_role("button", name="导出示教工程 ZIP").click()
        download = download_info.value
        archive = read_exported_archive(download)
        exported = archive["project"]
        assert download.suggested_filename.endswith(".zip")
        assert exported["schemaVersion"] == "1.3"
        assert archive["manifest"]["format"] == "atlas-route-studio-project"
        assert archive["manifest"]["statistics"]["cameraFrameCount"] == 2
        assert b"data:image/" not in archive["project_bytes"]
        assert b'"positionData"' not in archive["project_bytes"]
        assert b'"colorData"' not in archive["project_bytes"]
        for name, content in archive["files"].items():
            if name.endswith(".json"):
                assert b"data:image/" not in content
                assert b'"positionData"' not in content
                assert b'"colorData"' not in content
        teaching_pose = exported["virtualTeaching"]["tasks"][0]["parkingPoints"][0]["poses"][0]
        capture = teaching_pose["cameraCapture"]
        assert teaching_pose["fullBodyJoints"]["count"] == 24
        assert set(capture["frames"]) == {"left", "right"}
        assert any(name.endswith("/pose.json") for name in archive["names"])
        for side, frame in capture["frames"].items():
            assert "dataUrl" not in frame["rgb"]
            assert frame["rgb"]["file"] in archive["files"]
            cloud = frame["pointCloud"]
            assert "positionData" not in cloud
            assert "colorData" not in cloud
            assert cloud["metadataFile"] in archive["files"]
            assert cloud["preview"]["file"] in archive["files"]
            if cloud["pointCount"]:
                assert cloud["positionFile"] in archive["files"]
                assert cloud["colorFile"] in archive["files"]
                assert len(archive["files"][cloud["positionFile"]]) == cloud["pointCount"] * 6
                assert len(archive["files"][cloud["colorFile"]]) == cloud["pointCount"] * 3
        assert max(
            frame["pointCloud"]["pointCount"] for frame in capture["frames"].values()
        ) > 0

        page.locator('input[type="file"][accept*=".zip"]').set_input_files(
            str(archive["path"])
        )
        page.get_by_text("ZIP 工程包已加载", exact=False).wait_for()
        page.get_by_role("button", name="打开示教数据管理页").click()
        page.locator('[data-app-page="teaching-data"]').wait_for()
        page.get_by_role("button", name="查看机械臂姿态 A01").click()
        imported_vision = page.get_by_label("机械臂姿态双目视觉快照", exact=True)
        imported_vision.wait_for()
        assert imported_vision.locator(".teaching-vision-thumbnails img").count() == 4
        assert all(
            image.get_attribute("src").startswith("data:image/")
            for image in imported_vision.locator(".teaching-vision-thumbnails img").all()
        )

        page.wait_for_timeout(700)
        stored_capture = page.evaluate(
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
              return record?.config?.project?.virtualTeaching?.tasks?.[0]?.parkingPoints?.[0]?.poses?.[0]?.cameraCapture;
            }
            """
        )
        assert_camera_capture(stored_capture)

        page.reload(wait_until="domcontentloaded")
        page.locator(".teaching-data-page__session.is-ready").wait_for()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        restored_vision = page.get_by_label("机械臂姿态双目视觉快照", exact=True)
        restored_vision.wait_for()
        assert restored_vision.get_attribute("data-camera-frame-count") == "2"
        assert restored_vision.locator(".teaching-vision-thumbnails img").count() == 4

        page.screenshot(path="/tmp/atlas-teaching-vision-capture.png", full_page=True)
        print("camera_frames=", vision.get_attribute("data-camera-frame-count"))
        print("left_points=", capture["frames"]["left"]["pointCloud"]["pointCount"])
        print("right_points=", capture["frames"]["right"]["pointCloud"]["pointCount"])
        print("capture_bytes=", capture["storageByteLength"])
        print("page_errors=", page_errors)
        print("console_errors=", console_errors)
        print("failed_responses=", failed_responses)
        assert not page_errors
        assert not console_errors
        browser.close()


if __name__ == "__main__":
    run()
