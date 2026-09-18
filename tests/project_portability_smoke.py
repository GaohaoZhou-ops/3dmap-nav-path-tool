import hashlib
import json
import os
import subprocess
import tempfile
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
ROOT = Path(__file__).resolve().parents[1]
CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")


def create_fixture(path):
    subprocess.run(
        ["node", str(ROOT / "tests/project_archive_smoke.mjs"), str(path)],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )


def create_tampered_copy(source, target):
    with zipfile.ZipFile(source) as archive:
        files = {name: archive.read(name) for name in archive.namelist() if not name.endswith("/")}
    positions_path = "environment/positions.f32le"
    positions = bytearray(files[positions_path])
    positions[0] ^= 0xFF
    files[positions_path] = bytes(positions)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)


def validate_download(path):
    with zipfile.ZipFile(path) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["archiveVersion"] == 2
        assert manifest["portable"] is True
        assert manifest["identities"]["map"]["geometryDigest"]
        assert manifest["identities"]["robot"]["resourceDigest"]
        names = set(archive.namelist())
        assert "environment/positions.f32le" in names
        assert "environment/triangles.u16le" in names
        assert "robot/files/portable/robot.urdf" in names
        for record in manifest["files"]:
            body = archive.read(record["path"])
            assert len(body) == record["byteLength"]
            assert hashlib.sha256(body).hexdigest() == record["sha256"]


def run():
    errors = []
    portable_requests = []
    with tempfile.TemporaryDirectory(prefix="atlas-portable-test-") as directory:
        fixture = Path(directory) / "portable-project.zip"
        tampered = Path(directory) / "portable-project-tampered.zip"
        create_fixture(fixture)
        create_tampered_copy(fixture, tampered)

        with sync_playwright() as playwright:
            launch_options = {"headless": True}
            if CHROME.exists():
                launch_options["executable_path"] = str(CHROME)
            browser = playwright.chromium.launch(**launch_options)
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.set_default_timeout(60_000)
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on(
                "request",
                lambda request: portable_requests.append(request.url)
                if "/__atlas/robot-files/portable/" in request.url
                else None,
            )

            page.goto(f"{BASE_URL.rstrip('/')}/workbench", wait_until="networkidle")
            page.locator('[data-session-state="ready"]').wait_for()
            page.locator('input[type="file"][accept*=".zip"]').set_input_files(str(fixture))
            page.locator(".loading-curtain").wait_for(state="hidden")
            page.wait_for_function(
                "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'"
            )
            page.locator(".map-identity strong").filter(has_text="portable-test.ply").wait_for()
            assert page.locator(".map-identity strong").inner_text() == "portable-test.ply"
            assert page.get_by_label("二维矢量点云截面").get_attribute(
                "data-source-point-count"
            ) == "3"
            assert page.locator(".three-canvas").get_attribute("data-robot-model-name") == "Portable robot"
            assert not portable_requests

            stored_resources = page.evaluate(
                """
                async () => {
                  const database = await new Promise((resolve, reject) => {
                    const request = indexedDB.open('atlas-route-studio', 1);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                  });
                  const transaction = database.transaction('workspace-session', 'readonly');
                  const record = await new Promise((resolve, reject) => {
                    const request = transaction.objectStore('workspace-session').get('workspace-map:map');
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                  });
                  database.close();
                  return {
                    mapPoints: record?.pointCount || 0,
                    robotFiles: record?.portableRobotPackage?.files?.length || 0,
                  };
                }
                """
            )
            assert stored_resources == {"mapPoints": 3, "robotFiles": 1}

            page.reload(wait_until="domcontentloaded")
            page.locator('[data-session-state="ready"]').wait_for()
            page.wait_for_function(
                "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'"
            )
            assert page.locator(".map-identity strong").inner_text() == "portable-test.ply"
            assert not portable_requests

            page.get_by_role("button", name="打开示教数据管理页").click()
            page.locator('[data-app-page="teaching-data"]').wait_for()
            archive_tree = page.locator(".teaching-archive-tree")
            assert archive_tree.get_attribute("data-teaching-task-count") == "1"
            assert archive_tree.get_attribute("data-parking-point-count") == "1"
            assert archive_tree.get_attribute("data-teaching-point-count") == "1"
            with page.expect_download() as download_info:
                page.get_by_role("button", name="导出示教工程 ZIP").click()
            validate_download(Path(download_info.value.path()))
            page.get_by_role("button", name="返回主工作台继续示教").click()
            page.locator('[data-app-page="teaching-data"]').wait_for(state="detached")

            page.locator('input[type="file"][accept*=".zip"]').set_input_files(str(tampered))
            page.get_by_text("SHA-256 校验失败", exact=False).wait_for()
            assert page.locator(".map-identity strong").inner_text() == "portable-test.ply"
            assert not errors
            assert not portable_requests
            browser.close()

    print("portable_import=ok")
    print("portable_refresh=ok")
    print("portable_reexport=ok")
    print("tamper_detection=ok")


if __name__ == "__main__":
    run()
