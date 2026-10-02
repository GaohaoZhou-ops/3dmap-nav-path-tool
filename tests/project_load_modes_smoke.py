import base64
import os
import subprocess
import tempfile
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990").rstrip("/")
CHROME = Path(os.environ.get(
    "CHROME_EXECUTABLE", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
))
LABELS = {"map": "地图示教", "independent": "独立示教"}


def make_fixtures(root):
    subprocess.run(
        ["node", "--input-type=module", "-e", """
          import { writeFile } from 'node:fs/promises';
          import { buildExport } from './src/lib/io.js';
          import { buildProjectArchive } from './src/lib/projectArchive.js';
          for (const mode of ['map', 'independent']) {
            const map = {
              name: `${mode}-fixture.ply`, pointCount: 3, faceCount: 0,
              bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
              teachingSpaceMode: mode,
            };
            const project = buildExport({
              mapData: map, teachingSpaceMode: mode, heightRange: [-0.1, 0.1],
              waypoints: [], edges: [],
              teachingTasks: [{ id: `${mode}-task`, name: `${mode} task`, parkingPoints: [] }],
            });
            const archive = await buildProjectArchive(project, {
              mapResource: {
                ...map, geometryCacheVersion: 1,
                positionBuffer: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer,
              },
            });
            await writeFile(`${process.argv[1]}/${mode}.zip`, archive.bytes);
            await writeFile(`${process.argv[1]}/${mode}.json`, JSON.stringify(project));
          }
        """, str(root)],
        check=True, capture_output=True, text=True,
    )
    encoded = {}
    for mode in LABELS:
        directory = root / f"{mode}.atlas-project"
        with zipfile.ZipFile(root / f"{mode}.zip") as archive:
            archive.extractall(directory)
        encoded[mode] = {
            path.relative_to(directory).as_posix(): base64.b64encode(path.read_bytes()).decode()
            for path in directory.rglob("*") if path.is_file()
        }
    return encoded


def wait_ready(page):
    page.locator('[data-session-state="ready"]:visible').first.wait_for()
    page.locator(".loading-curtain").wait_for(state="hidden")


def home(page, mode):
    if page.url.rstrip("/") != BASE_URL:
        page.get_by_role("button", name="返回主页面", exact=True).click()
    page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
    page.get_by_role("radio", name=LABELS[mode]).click()


def open_loader(page, mode):
    home(page, mode)
    page.get_by_role("button", name="加载工程", exact=True).click()
    dialog = page.get_by_role("dialog", name="加载工程")
    dialog.wait_for()
    page.wait_for_function(
        "document.querySelector('.project-load-modal')?.dataset.defaultSource !== 'checking'"
    )
    assert dialog.get_attribute("data-teaching-space-mode") == mode
    assert f"仅加载{LABELS[mode]}工程" in dialog.inner_text()
    return dialog


def close_loader(page):
    page.get_by_role("button", name="关闭加载工程窗口").click()


def choose_file(page, path, directory=False):
    label = "选择其他工程目录" if directory else "加载工程引导文件"
    with page.expect_file_chooser() as chooser:
        page.get_by_role("button", name=label, exact=True).click()
    chooser.value.set_files(str(path))
    wait_ready(page)


def assert_mode(page, mode):
    page.wait_for_url(f"{BASE_URL}/workbench")
    page.locator(f'.app-shell[data-app-page="workbench"][data-teaching-space-mode="{mode}"]').wait_for()
    wait_ready(page)
    assert page.locator('.app-shell[data-app-page="workbench"]').get_attribute(
        "data-teaching-space-mode"
    ) == mode


def workspaces(page):
    return page.evaluate("""async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('atlas-route-studio', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const records = await new Promise((resolve, reject) => {
          const request = db.transaction('workspace-session').objectStore('workspace-session').getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return Object.fromEntries(records.filter(r => r.key.startsWith('workspace-config:') && r.config?.project)
          .map(r => [r.key, {
            mode: r.config.project.workspace.teachingSpaceMode,
            map: r.config.project.map?.fileName,
            tasks: r.config.project.virtualTeaching.tasks.map(t => t.id),
          }]));
      } finally { db.close(); }
    }""")


def assert_rejected(page, actual_mode, snapshot):
    page.get_by_text(f"所选工程属于“{LABELS[actual_mode]}”", exact=False).wait_for()
    page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
    assert workspaces(page) == snapshot


def install_directories(page, encoded):
    page.evaluate("""async (projects) => {
      const root = await navigator.storage.getDirectory();
      for (const [mode, files] of Object.entries(projects)) {
        const project = await root.getDirectoryHandle(`${mode}.atlas-project`, { create: true });
        for (const [path, bytes] of Object.entries(files)) {
          const parts = path.split('/');
          const name = parts.pop();
          let dir = project;
          for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
          const file = await dir.getFileHandle(name, { create: true });
          const writer = await file.createWritable();
          await writer.write(Uint8Array.from(atob(bytes), c => c.charCodeAt(0)));
          await writer.close();
        }
      }
    }""", encoded)


def run():
    errors = []
    with tempfile.TemporaryDirectory(prefix="atlas-load-modes-") as temporary, sync_playwright() as p:
        root = Path(temporary)
        encoded = make_fixtures(root)
        options = {"headless": True}
        if CHROME.exists():
            options["executable_path"] = str(CHROME)
        browser = p.chromium.launch(**options)
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.add_init_script(
                "window.showDirectoryPicker = undefined; window.showOpenFilePicker = undefined;"
            )
            page.goto(BASE_URL, wait_until="networkidle")
            wait_ready(page)
            for mode in ("independent", "map"):
                other = "map" if mode == "independent" else "independent"
                snapshot = workspaces(page)
                for source in ("directory", "zip", "json"):
                    open_loader(page, mode)
                    path = root / (f"{other}.atlas-project" if source == "directory" else f"{other}.{source}")
                    choose_file(page, path, directory=source == "directory")
                    assert_rejected(page, other, snapshot)
                open_loader(page, mode)
                choose_file(page, root / f"{mode}.atlas-project", directory=True)
                assert_mode(page, mode)
                open_loader(page, mode)
                choose_file(page, root / f"{mode}.zip")
                assert_mode(page, mode)
                open_loader(page, mode)
                choose_file(page, root / f"{mode}.json")
                assert_mode(page, mode)
            assert len(workspaces(page)) == 2
            for mode in LABELS:
                assert open_loader(page, mode).get_attribute("data-default-source") == "workspace"
                page.get_by_role("button", name="加载自动保存工程", exact=True).click()
                assert_mode(page, mode)
            print("directory_zip_json_type_checks=ok")
            print("mode_scoped_cached_workspace_load=ok")

            # Real OPFS directory handles exercise IndexedDB persistence across reloads.
            native = browser.new_page(viewport={"width": 1440, "height": 900})
            native.on("pageerror", lambda error: errors.append(str(error)))
            native.add_init_script("""
              window.__nextMode = 'map'; window.__pickerCalls = [];
              window.showDirectoryPicker = async (options) => {
                window.__pickerCalls.push({id: options.id, startIn: options.startIn?.name});
                const root = await navigator.storage.getDirectory();
                return root.getDirectoryHandle(`${window.__nextMode}.atlas-project`);
              };
            """)
            native.goto(BASE_URL, wait_until="networkidle")
            wait_ready(native)
            install_directories(native, encoded)
            for mode in LABELS:
                assert open_loader(native, mode).get_attribute("data-default-source") == "none"
                native.evaluate("mode => window.__nextMode = mode", mode)
                native.get_by_role("button", name="选择其他工程目录", exact=True).click()
                assert_mode(native, mode)
                call = native.evaluate("window.__pickerCalls.at(-1)")
                assert call["id"] == f"atlas-project-{mode}"
            expected = workspaces(native)
            for mode in ("independent", "map"):
                native.reload(wait_until="networkidle")
                wait_ready(native)
                dialog = open_loader(native, mode)
                assert dialog.get_attribute("data-default-source") == "directory"
                assert dialog.locator("h3").inner_text() == f"{mode}.atlas-project"
                native.get_by_role("button", name="从默认保存路径加载", exact=True).click()
                assert_mode(native, mode)
                assert workspaces(native) == expected

            open_loader(native, "map")
            native.evaluate("window.__nextMode = 'independent'")
            native.get_by_role("button", name="选择其他工程目录", exact=True).click()
            assert_rejected(native, "independent", expected)
            assert native.evaluate("window.__pickerCalls.at(-1)") == {
                "id": "atlas-project-map", "startIn": "map.atlas-project"
            }
            # A stale binding must also pass the actual project's type check.
            native.evaluate("""async () => {
              const { saveProjectDirectoryBinding } = await import('/src/lib/projectDirectoryStore.js');
              const root = await navigator.storage.getDirectory();
              await saveProjectDirectoryBinding({
                handle: await root.getDirectoryHandle('independent.atlas-project'),
                teachingSpaceMode: 'map', sessionId: 'stale-binding',
              });
            }""")
            native.reload(wait_until="networkidle")
            wait_ready(native)
            open_loader(native, "map")
            native.get_by_role("button", name="从默认保存路径加载", exact=True).click()
            assert_rejected(native, "independent", expected)
            print("directory_picker_memory_and_persisted_defaults=ok")
            print("native_and_stale_default_type_checks=ok")

            # Legacy untyped directory bindings must not migrate into both modes.
            legacy = browser.new_page(viewport={"width": 1440, "height": 900})
            legacy.on("pageerror", lambda error: errors.append(str(error)))
            legacy.goto(BASE_URL, wait_until="networkidle")
            wait_ready(legacy)
            legacy.evaluate("""async () => {
              const db = await new Promise(resolve => {
                const request = indexedDB.open('atlas-project-directory-bindings', 1);
                request.onsuccess = () => resolve(request.result);
              });
              const tx = db.transaction('bindings', 'readwrite');
              tx.objectStore('bindings').put({
                key: 'active-project', name: 'legacy-map-directory',
                handle: { kind: 'directory', name: 'legacy-map-directory' }, sessionId: 'legacy',
              });
              await new Promise((resolve, reject) => {
                tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
              });
              db.close();
            }""")
            assert open_loader(legacy, "independent").get_attribute("data-default-source") == "none"
            close_loader(legacy)
            assert open_loader(legacy, "map").get_attribute("data-default-source") == "directory"
            close_loader(legacy)
            print("legacy_binding_isolation=ok")

            # Older recovery metadata has no mode; infer it from its stored project.
            recovery = browser.new_page(viewport={"width": 1440, "height": 900})
            recovery.on("pageerror", lambda error: errors.append(str(error)))
            recovery.add_init_script(
                "window.showDirectoryPicker = undefined; window.showOpenFilePicker = undefined;"
            )
            recovery.goto(BASE_URL, wait_until="networkidle")
            wait_ready(recovery)
            recovery.evaluate("""async (encodedZip) => {
              const { readProjectArchive } = await import('/src/lib/projectArchive.js');
              const imported = await readProjectArchive(Uint8Array.from(atob(encodedZip), c => c.charCodeAt(0)));
              const db = await new Promise(resolve => {
                const request = indexedDB.open('atlas-route-studio', 1);
                request.onsuccess = () => resolve(request.result);
              });
              const tx = db.transaction('workspace-session', 'readwrite');
              const store = tx.objectStore('workspace-session');
              const common = { recoveryId: 'legacy-recovery', mapId: 'recovered-independent', sessionId: 'previous' };
              store.put({ ...common, key: 'recovery-meta', available: true, mapName: 'independent-fixture.ply' });
              store.put({ ...imported.resources.map, ...common, key: 'recovery-map' });
              store.put({ ...common, key: 'recovery-config', config: { project: imported.payload } });
              await new Promise((resolve, reject) => {
                tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
              });
              db.close();
            }""", base64.b64encode((root / "independent.zip").read_bytes()).decode())
            recovery.reload(wait_until="networkidle")
            wait_ready(recovery)
            assert open_loader(recovery, "map").get_attribute("data-default-source") == "none"
            close_loader(recovery)
            assert open_loader(recovery, "independent").get_attribute("data-default-source") == "recovery"
            close_loader(recovery)
            error = recovery.evaluate("""async () => {
              const { activateWorkspaceRecovery, fetchServiceSession } = await import('/src/lib/sessionStore.js');
              try { await activateWorkspaceRecovery((await fetchServiceSession()).sessionId, 'map'); }
              catch (error) { return error.message; }
              return null;
            }""")
            assert "类型与当前入口不一致" in error
            open_loader(recovery, "map")
            choose_file(recovery, root / "map.zip")
            assert_mode(recovery, "map")
            map_before = workspaces(recovery)["workspace-config:map"]
            assert open_loader(recovery, "independent").get_attribute("data-default-source") == "recovery"
            recovery.once("dialog", lambda dialog: dialog.accept())
            recovery.get_by_role("button", name="恢复上一次自动保存工程", exact=True).click()
            assert_mode(recovery, "independent")
            assert workspaces(recovery)["workspace-config:map"] == map_before
            assert workspaces(recovery)["workspace-config:independent"]["tasks"] == ["independent-task"]
            dialog = open_loader(recovery, "independent")
            assert dialog.get_attribute("data-default-source") == "workspace"
            recovery.screenshot(
                path="/tmp/atlas-project-load-mode-isolation.png", full_page=True, animations="disabled"
            )
            print("legacy_recovery_type_filter_and_preserved_other_cache=ok")
            assert not errors, errors
        finally:
            browser.close()


if __name__ == "__main__":
    run()
