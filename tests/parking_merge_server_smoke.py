import hashlib
import json
import os
import shutil
import tempfile
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
CHROMIUM_EXECUTABLE = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE")
ROOT = Path(__file__).resolve().parents[1]


def result_archive(path, job_manifest, analysis, map_hash=None):
    analysis_bytes = json.dumps(
        analysis,
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
        allow_nan=False,
    ).encode()
    binding = json.loads(json.dumps(job_manifest["binding"]))
    if map_hash is not None:
        binding["map"]["sourceHash"] = map_hash
    manifest = {
        "format": "atlas-parking-merge-server-result",
        "archiveVersion": 1,
        "schemaVersion": 1,
        "createdAt": "2026-09-15T12:00:00Z",
        "job": {
            "id": job_manifest["jobId"],
            "inputDigest": job_manifest["inputDigest"],
        },
        "algorithm": job_manifest["algorithm"],
        "binding": binding,
        "resultFile": "result/analysis.json",
        "resultSha256": hashlib.sha256(analysis_bytes).hexdigest(),
    }
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        archive.writestr("result/analysis.json", analysis_bytes)


def run():
    page_errors = []
    with sync_playwright() as playwright:
        launch_options = {"headless": True}
        if CHROMIUM_EXECUTABLE:
            launch_options["executable_path"] = CHROMIUM_EXECUTABLE
        browser = playwright.chromium.launch(**launch_options)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(240_000)
        page.on("pageerror", lambda error: page_errors.append(str(error)))

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
            timeout=240_000,
        )

        page.get_by_role("tab", name="虚拟示教与相机").click()
        page.get_by_role("button", name="新建示教任务", exact=True).click()
        create_dialog = page.get_by_role("dialog", name="新建示教任务")
        create_dialog.get_by_role("textbox", name="新示教任务名称").fill("Server 合并验证")
        create_dialog.get_by_role("button", name="添加当前位置为停车点").click()
        create_dialog.get_by_role("button", name="创建任务", exact=True).click()
        page.get_by_role("button", name="记录当前机械臂姿态").click()
        page.wait_for_function(
            "document.querySelector('[aria-label=\"虚拟示教\"]')?.dataset.teachingPointCount === '1'"
        )

        page.get_by_role("button", name="定位机器人模型").click()
        page.keyboard.press("w")
        page.keyboard.press("w")
        page.get_by_role("button", name="记录当前机械臂姿态").click()
        drift_dialog = page.get_by_role("dialog", name="底盘已移动")
        drift_dialog.wait_for()
        drift_dialog.get_by_role("button", name="新建停车点并记录当前姿态").click()
        page.wait_for_function(
            "document.querySelector('[aria-label=\"虚拟示教\"]')?.dataset.parkingPointCount === '2'"
        )

        page.get_by_role("button", name="打开示教数据管理页").click()
        page.locator('[data-app-page="teaching-data"]').wait_for()
        page.get_by_role("button", name="选择示教任务 Server 合并验证").click()
        server_button = page.get_by_role(
            "button", name="打开合并停车点 Server 导入导出"
        )
        assert server_button.is_enabled()
        server_button.click()
        dialog = page.get_by_role("dialog", name="合并停车点-Server")
        dialog.wait_for()
        assert dialog.get_by_role("button", name="导出 Server 计算包").is_enabled()
        assert dialog.get_by_role("button", name="导入 Server 计算结果").is_enabled()
        assert dialog.get_by_role(
            "switch", name="Server 环境终态碰撞校验"
        ).get_attribute("aria-checked") == "true"
        assert dialog.get_by_role(
            "spinbutton", name="Server 停车点聚类半径"
        ).input_value() == "0.35"
        runbook = dialog.get_by_role("region", name="导出后的集群操作")
        assert runbook.get_by_text("解压计算包", exact=True).is_visible()
        assert runbook.get_by_text("进入任务目录", exact=True).is_visible()
        assert runbook.get_by_text("部署环境并开始计算", exact=True).is_visible()
        assert "unzip parking-merge-server-*.zip -d merge-job" in runbook.inner_text()
        assert "bash run_cluster.sh --workers 8" in runbook.inner_text()
        page.wait_for_timeout(250)
        page.screenshot(path="/tmp/atlas-parking-merge-server-dialog.png", full_page=True)

        with page.expect_download(timeout=240_000) as download_info:
            dialog.get_by_role("button", name="导出 Server 计算包").click()
        download = download_info.value
        archive_path = Path(download.path())
        shutil.copy2(archive_path, "/tmp/atlas-parking-merge-server-job.zip")
        assert download.suggested_filename.startswith("parking-merge-server-")
        with zipfile.ZipFile(archive_path) as archive:
            names = set(archive.namelist())
            manifest = json.loads(archive.read("manifest.json"))
            task = json.loads(archive.read("input/task.json"))
            config = json.loads(archive.read("input/config.json"))
            assert manifest["format"] == "atlas-parking-merge-server-job"
            assert manifest["archiveVersion"] == 1
            assert manifest["algorithm"]["version"] == "1.0.0"
            assert manifest["binding"]["map"]["sourceHash"]
            assert manifest["binding"]["robot"]["resourceDigest"]
            assert manifest["binding"]["task"]["digest"]
            assert task["name"] == "Server 合并验证"
            assert len(task["parkingPoints"]) == 2
            assert config["environmentCollision"]["enabled"] is True
            assert "environment/positions.f32le" in names
            assert "scripts/compute_parking_merge.py" in names
            assert "run_cluster.sh" in names
            assert "requirements.txt" in names
            compute_source = archive.read("scripts/compute_parking_merge.py").decode()
            run_source = archive.read("run_cluster.sh").decode()
            assert "class TerminalProgress" in compute_source
            assert "候选位姿规划" in compute_source
            assert "[SETUP 3/3]" in run_source
            assert any(name.endswith(".urdf") for name in names)
            assert any("meshes/" in name and name.lower().endswith(".stl") for name in names)
            assert not any(name.endswith("meshes/ZividTwo.stl") for name in names)
            for record in manifest["files"]:
                payload = archive.read(record["path"])
                assert len(payload) == record["byteLength"]
                assert hashlib.sha256(payload).hexdigest() == record["sha256"]

        analysis = {
            "version": 1,
            "status": "no-neighbors",
            "taskId": task["id"],
            "analyzedAt": "2026-09-15T12:00:00Z",
            "method": "server-xy-single-link+common-base-dual-optical-dls+final-pose-environment-obb",
            "distanceThreshold": 0.35,
            "positionTolerance": 0.05,
            "rotationTolerance": 5,
            "clusters": [],
            "nearbyPairs": [],
            "isolatedParkingPointIds": [item["id"] for item in task["parkingPoints"]],
            "feasibleClusterCount": 0,
        }
        temporary = Path(tempfile.mkdtemp(prefix="atlas-server-result-"))
        mismatch_path = temporary / "wrong-map-result.zip"
        valid_path = temporary / "valid-result.zip"
        result_archive(mismatch_path, manifest, analysis, map_hash="wrong-map-sha256")
        result_archive(valid_path, manifest, analysis)

        result_input = dialog.locator('input[type="file"]')
        result_input.set_input_files(str(mismatch_path))
        dialog.get_by_text("结果已拒绝", exact=True).wait_for()
        assert "地图 SHA-256" in dialog.get_by_role("status").inner_text()

        result_input.set_input_files(str(valid_path))
        dialog.wait_for(state="detached", timeout=240_000)
        merge_dialog = page.get_by_role("dialog", name="合并停车点")
        merge_dialog.wait_for()
        assert merge_dialog.get_by_text(
            "SERVER RESULT / MANIFEST VERIFIED", exact=True
        ).is_visible()
        assert merge_dialog.get_by_text(
            "当前半径内没有近邻停车点", exact=True
        ).is_visible()
        page.wait_for_timeout(250)
        page.screenshot(path="/tmp/atlas-parking-merge-server-import.png", full_page=True)

        print("server_job=", manifest["jobId"])
        print("server_archive_bytes=", archive_path.stat().st_size)
        print("server_files=", len(manifest["files"]) + 1)
        print("page_errors=", page_errors)
        assert not page_errors
        browser.close()


if __name__ == "__main__":
    run()
