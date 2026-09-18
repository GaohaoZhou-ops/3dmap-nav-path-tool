import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
FIXTURE = Path(__file__).parent / "fixtures" / "rotation-map.ply"


def wait_for_session(page):
    page.locator('[data-session-state="ready"]').wait_for(timeout=30_000)
    page.locator(".loading-curtain").wait_for(state="hidden", timeout=30_000)


def read_independent_workspace(page):
    return page.evaluate(
        """
        async () => {
          const database = await new Promise((resolve, reject) => {
            const request = indexedDB.open('atlas-route-studio', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const transaction = database.transaction('workspace-session', 'readonly');
          const store = transaction.objectStore('workspace-session');
          const read = (key) => new Promise((resolve, reject) => {
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const [mapRecord, configRecord] = await Promise.all([
            read('workspace-map:independent'),
            read('workspace-config:independent'),
          ]);
          database.close();
          return {
            cachedMode: mapRecord?.teachingSpaceMode || null,
            cachedFrame: mapRecord?.coordinateFrame || null,
            projectMode: configRecord?.config?.project?.workspace?.teachingSpaceMode || null,
            projectFrame: configRecord?.config?.project?.coordinateSystem?.frameId || null,
            originSource: configRecord?.config?.project?.teachingSpace?.originSource || null,
          };
        }
        """
    )


def assert_independent_ui(page, expected_geometry_source):
    shell = page.locator('.app-shell[data-app-page="workbench"]')
    assert shell.get_attribute("data-teaching-space-mode") == "independent"
    assert shell.get_attribute("data-coordinate-frame") == "virtual_origin"
    assert "VIRTUAL SPACE" in page.locator(".map-identity").inner_text()
    assert page.get_by_role("button", name="创建独立示教空间").get_attribute("aria-pressed") == "true"
    assert "独立示教空间" in page.locator(".panel-3d .panel-heading__title").inner_text()
    workspace = page.locator(".visual-workspace")
    assert workspace.get_attribute("data-workspace-layout") == "spatial-only"
    assert page.locator(".panel-2d").count() == 0
    assert page.locator(".map2d-view").count() == 0
    assert page.get_by_role("toolbar", name="二维地图工具").count() == 0
    assert page.get_by_role("button", name="折叠3D窗口").count() == 0
    workspace_box = workspace.bounding_box()
    panel_box = page.locator(".panel-3d").bounding_box()
    assert workspace_box and panel_box
    assert abs(workspace_box["height"] - panel_box["height"]) < 1
    assert "VIRTUAL_ORIGIN" in page.locator(".statusbar").inner_text()
    canvas = page.locator(".three-canvas")
    assert canvas.get_attribute("data-geometry-source") == expected_geometry_source
    assert canvas.get_attribute("data-teaching-space-mode") == "independent"
    assert canvas.get_attribute("data-coordinate-frame") == "virtual_origin"
    assert canvas.get_attribute("data-space-origin") == "0,0,0"
    assert canvas.get_attribute("data-reference-plane") == "virtual-origin-reference-plane"
    assert canvas.get_attribute("data-reference-plane-position") == "0,0,0"


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(30_000)
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        page.goto(f"{BASE_URL.rstrip('/')}/workbench")
        page.wait_for_load_state("networkidle")
        wait_for_session(page)

        independent_input = page.locator('[data-independent-teaching-input="true"]')
        independent_input.set_input_files(str(FIXTURE))
        page.locator(".map-state-dot.online").wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.locator(".projection-status").wait_for(state="hidden")
        assert_independent_ui(page, "ply-parse")

        page.wait_for_timeout(900)
        workspace = read_independent_workspace(page)
        assert workspace == {
            "cachedMode": "independent",
            "cachedFrame": "virtual_origin",
            "projectMode": "independent",
            "projectFrame": "virtual_origin",
            "originSource": "point-cloud-origin",
        }

        page.reload(wait_until="domcontentloaded")
        wait_for_session(page)
        page.locator(".projection-status").wait_for(state="hidden")
        assert_independent_ui(page, "session-cache")
        assert page.locator(".session-guard").get_attribute("data-session-restored") == "true"
        page.screenshot(path="/tmp/atlas-independent-teaching-space.png", full_page=True)

        # The existing full-map loader remains a separate mode and switches the
        # coordinate frame back without requiring a page refresh.
        page.locator('input[type="file"][accept=".ply"]').set_input_files(str(FIXTURE))
        page.wait_for_function(
            "document.querySelector('.app-shell[data-app-page=workbench]')?.dataset.teachingSpaceMode === 'map'"
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.locator(".projection-status").wait_for(state="hidden")
        assert page.locator('.app-shell[data-app-page="workbench"]').get_attribute(
            "data-coordinate-frame"
        ) == "map"
        assert page.locator(".three-canvas").get_attribute("data-reference-plane") == "map-reference-plane"
        assert page.get_by_role("button", name="创建独立示教空间").get_attribute(
            "aria-pressed"
        ) == "false"
        assert page.locator(".visual-workspace").get_attribute(
            "data-workspace-layout"
        ) == "spatial-and-map"
        assert page.locator(".panel-2d").count() == 1
        assert page.locator(".map2d-view").count() == 1

        print("independent_workspace=", workspace)
        print("page_errors=", errors)
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
