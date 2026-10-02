import os
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990").rstrip("/")
CHROME = Path(os.environ.get("CHROME_EXECUTABLE", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"))


def ready(page, mode):
    page.locator(f'.app-shell[data-app-page="workbench"][data-teaching-space-mode="{mode}"][aria-hidden="false"]').wait_for()
    page.locator('[data-session-state="ready"]:visible').wait_for()
    page.locator(".loading-curtain").wait_for(state="hidden")
    page.locator('.three-canvas[data-robot-model-state="loaded"]').wait_for()


def seed(page, modes, active, bind_directories=False, fixture_name="teachingTransferFixture"):
    page.goto(BASE_URL, wait_until="networkidle")
    page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
    page.evaluate("""async ({ modes, active, bindDirectories, fixtureName }) => {
      const fixtures = await import('/tests/teaching_transfer_helpers.mjs');
      const { transferFixtureFiles } = fixtures;
      const store = await import('/src/lib/sessionStore.js');
      const { sessionId } = await store.fetchServiceSession();
      for (const mode of modes) {
        const fixture = fixtures[fixtureName](mode);
        await store.saveWorkspaceMap(sessionId, fixture.map.mapId, fixture.map.name, fixture.map, mode);
        await store.saveWorkspaceConfig(sessionId, fixture.map.mapId, fixture.config.config, mode);
        if (bindDirectories) {
          const root = await navigator.storage.getDirectory();
          const directory = await root.getDirectoryHandle(`${mode}-original`, {create: true});
          for (const [path, bytes] of Object.entries(await transferFixtureFiles(fixture))) {
            const parts = path.split('/'), name = parts.pop();
            let folder = directory;
            for (const part of parts) folder = await folder.getDirectoryHandle(part, {create: true});
            const handle = await folder.getFileHandle(name, {create: true});
            const writer = await handle.createWritable();
            await writer.write(bytes); await writer.close();
          }
          const { saveProjectDirectoryBinding } = await import('/src/lib/projectDirectoryStore.js');
          await saveProjectDirectoryBinding({handle: directory, teachingSpaceMode: mode, sessionId});
        }
      }
      await store.activateWorkspaceMode(sessionId, active);
    }""", {"modes": modes, "active": active, "bindDirectories": bind_directories, "fixtureName": fixture_name})
    page.goto(f"{BASE_URL}/workbench", wait_until="networkidle")
    ready(page, active)


def snapshot(page, mode):
    return page.evaluate("""async mode => {
      const store = await import('/src/lib/sessionStore.js');
      const data = await store.loadWorkspaceSnapshot((await store.fetchServiceSession()).sessionId, mode);
      return { project: data.config?.config.project, pointCount: data.map?.pointCount,
        mapId: data.map?.mapId, sourceHash: data.map?.sourceHash,
        positions: data.map?.positionBuffer ? Array.from(new Float32Array(data.map.positionBuffer)) : [] };
    }""", mode)


def open_transfer(page):
    page.get_by_role("button", name="打开示教转换", exact=True).click()
    dialog = page.get_by_role("dialog", name="示教转换", exact=True)
    dialog.wait_for()
    dialog.locator(".transfer-route").wait_for()
    if dialog.locator("canvas").count():
        dialog.locator('canvas[data-render-state="ready"]').wait_for()
    return dialog


def directory_project(page, mode):
    return page.evaluate("""async mode => {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle(`${mode}-original`);
      const config = await directory.getDirectoryHandle('config');
      return JSON.parse(await (await (await config.getFileHandle('project.json')).getFile()).text());
    }""", mode)


def run():
    errors = []
    with sync_playwright() as p:
        options = {"headless": True}
        if CHROME.exists():
            options["executable_path"] = str(CHROME)
        browser = p.chromium.launch(**options)
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            page.set_default_timeout(30_000)
            page.on("pageerror", lambda error: errors.append(str(error)))
            seed(page, ["independent"], "independent")
            dialog = open_transfer(page)
            assert dialog.get_by_text("先打开目标地图工程", exact=True).is_visible()
            dialog.get_by_role("button", name="前往主页面加载地图").click()
            assert page.locator('[data-app-page="home"]').get_attribute("data-selected-teaching-mode") == "map"

            # Load the target without changing the source, then place using the UI.
            seed(page, ["map", "independent"], "independent", bind_directories=True)
            original_directory = directory_project(page, "map")
            source_before = snapshot(page, "independent")
            dialog = open_transfer(page)
            preview = dialog.get_by_label("地图转换三维预览")
            preview.click(position={"x": 320, "y": 170})
            assert float(dialog.get_by_label("放置 X", exact=True).input_value()) != 10
            dialog.get_by_label("放置定位基准").select_option("robot")
            for label, value in {"X": "15", "Y": "24", "Z": "2", "Roll": "0", "Pitch": "0", "Yaw": "45"}.items():
                dialog.get_by_label(f"放置 {label}", exact=True).fill(value)
            page.screenshot(path="/tmp/atlas-transfer-placement.png", full_page=True)
            dialog.get_by_role("button", name="放置并进入地图", exact=True).click()
            ready(page, "map")
            placed = snapshot(page, "map")
            assert placed["pointCount"] == 12
            assert len(placed["project"]["virtualTeaching"]["tasks"]) == 2
            for axis, value in {"x": 15, "y": 24, "z": 2}.items():
                assert abs(placed["project"]["robot"]["origin"]["position"][axis] - value) < 1e-6
            assert placed["project"]["workspace"]["directoryAutosaveSuspended"] is True
            assert directory_project(page, "map") == original_directory
            assert snapshot(page, "independent")["positions"] == source_before["positions"]
            page.close()

            # The first extraction creates an independent workspace directly.
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            page.on("pageerror", lambda error: errors.append(str(error)))
            seed(page, ["map"], "map")
            dialog = open_transfer(page)
            assert dialog.get_by_role("checkbox", name=re.compile("用本次提取")).count() == 0
            dialog.get_by_role("button", name="提取并进入独立示教", exact=True).click()
            ready(page, "independent")
            assert snapshot(page, "independent")["pointCount"] == 6
            assert snapshot(page, "map")["pointCount"] == 6
            page.close()

            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            page.on("pageerror", lambda error: errors.append(str(error)))
            seed(page, ["map", "independent"], "map", bind_directories=True)
            original_independent_directory = directory_project(page, "independent")
            original_map = snapshot(page, "map")
            dialog = open_transfer(page)
            submit = dialog.get_by_role("button", name="提取并进入独立示教", exact=True)
            assert submit.is_disabled()
            dialog.get_by_role("button", name="俯视框选", exact=True).click()
            preview_box = dialog.get_by_label("地图转换三维预览").bounding_box()
            page.mouse.move(preview_box["x"] + 20, preview_box["y"] + 100)
            page.mouse.down()
            page.mouse.move(preview_box["x"] + 180, preview_box["y"] + 220, steps=5)
            page.mouse.up()
            assert float(dialog.get_by_label("裁剪 X 最大值").input_value()) < 31
            for axis, limits in {"X": (9, 12), "Y": (19, 22), "Z": (0, 2)}.items():
                dialog.get_by_label(f"裁剪 {axis} 最小值").fill(str(limits[0]))
                dialog.get_by_label(f"裁剪 {axis} 最大值").fill(str(limits[1]))
            dialog.get_by_role("checkbox", name=re.compile("用本次提取")).check()
            page.screenshot(path="/tmp/atlas-transfer-crop.png", full_page=True)
            submit.click()
            ready(page, "independent")
            extracted = snapshot(page, "independent")
            assert extracted["pointCount"] == 3
            assert len(extracted["project"]["virtualTeaching"]["tasks"][0]["parkingPoints"]) == 1
            assert all(abs(value) < 1e-6 for value in extracted["project"]["robot"]["origin"]["position"].values())
            assert snapshot(page, "map")["positions"] == original_map["positions"]
            assert directory_project(page, "independent") == original_independent_directory

            # Refine through the existing teaching-data UI and return to the source.
            page.get_by_role("button", name="打开示教数据管理页", exact=True).click()
            page.get_by_role("button", name="选择停车点 map-inside", exact=True).click()
            page.get_by_label("停车点名称", exact=True).fill("局部精调后的停车点")
            page.get_by_label("停车点名称", exact=True).press("Enter")
            page.get_by_role("button", name="继续工作 · 返回主工作台继续示教", exact=True).click()
            ready(page, "independent")
            dialog = open_transfer(page)
            assert dialog.get_by_label("放置 X", exact=True).get_attribute("readonly") is not None
            page.screenshot(path="/tmp/atlas-transfer-writeback.png", full_page=True)
            dialog.get_by_role("button", name="回写并进入地图", exact=True).click()
            ready(page, "map")
            returned = snapshot(page, "map")
            stops = returned["project"]["virtualTeaching"]["tasks"][0]["parkingPoints"]
            assert stops[0]["name"] == "局部精调后的停车点"
            assert stops[1]["name"] == "map-outside"
            assert returned["positions"] == original_map["positions"]
            page.wait_for_function("""async () => {
              const root = await navigator.storage.getDirectory();
              const directory = await root.getDirectoryHandle('map-original');
              const config = await directory.getDirectoryHandle('config');
              const project = JSON.parse(await (await (await config.getFileHandle('project.json')).getFile()).text());
              return project.virtualTeaching.tasks[0].parkingPoints[0].name === '局部精调后的停车点';
            }""")

            page.get_by_role("button", name="切换到独立示教", exact=True).click()
            ready(page, "independent")
            assert snapshot(page, "independent")["project"]["workspace"]["transfer"]["lastWrittenAt"]
            dialog = open_transfer(page)
            dialog.get_by_role("button", name="回写并进入地图", exact=True).click()
            ready(page, "map")
            assert len(snapshot(page, "map")["project"]["virtualTeaching"]["tasks"][0]["parkingPoints"]) == 2

            # A concurrent target edit after preview must abort the entire commit.
            page.get_by_role("button", name="切换到独立示教", exact=True).click()
            ready(page, "independent")
            dialog = open_transfer(page)
            page.evaluate("""async () => {
              const store = await import('/src/lib/sessionStore.js');
              const { sessionId } = await store.fetchServiceSession();
              const target = await store.loadWorkspaceSnapshot(sessionId, 'map');
              target.config.config.project.virtualTeaching.tasks[0].parkingPoints[0].name = 'Concurrent edit';
              const db = await new Promise(resolve => { const r = indexedDB.open('atlas-route-studio', 1); r.onsuccess = () => resolve(r.result); });
              const tx = db.transaction('workspace-session', 'readwrite');
              tx.objectStore('workspace-session').put({ ...target.config, savedAt: target.config.savedAt + 1 });
              await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
              db.close();
            }""")
            concurrent = snapshot(page, "map")
            dialog.get_by_role("button", name="回写并进入地图", exact=True).click()
            dialog.get_by_role("alert").get_by_text("工程在转换期间发生了修改", exact=False).wait_for()
            assert snapshot(page, "map") == concurrent
            assert page.locator('.app-shell[data-app-page="workbench"]').get_attribute("data-teaching-space-mode") == "independent"
            print("placement_preview_and_missing_map=ok")
            print("first_extraction_to_empty_workspace=ok")
            print("crop_refine_and_repeated_writeback=ok")
            print("concurrent_edit_atomic_rejection=ok")
            print("derived_project_directory_preservation_and_writeback_autosave=ok")
            print("page_errors=", errors)
            assert not errors, errors
        finally:
            browser.close()


if __name__ == "__main__":
    run()
