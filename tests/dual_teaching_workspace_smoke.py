import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990").rstrip("/")
FIXTURE = Path(__file__).parent / "fixtures" / "rotation-map.ply"


def wait_for_home(page):
    page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for(
        timeout=30_000
    )


def wait_for_workbench(page, mode):
    page.wait_for_url(f"{BASE_URL}/workbench", timeout=30_000)
    shell = page.locator('.app-shell[data-app-page="workbench"][aria-hidden="false"]')
    shell.wait_for(timeout=30_000)
    page.locator(".loading-curtain").wait_for(state="hidden", timeout=30_000)
    page.locator(".projection-status").wait_for(state="hidden", timeout=30_000)
    assert shell.get_attribute("data-teaching-space-mode") == mode


def create_project(page, mode):
    page.get_by_role("radio", name="独立示教" if mode == "independent" else "地图示教").click()
    with page.expect_file_chooser() as chooser_info:
        page.get_by_role("button", name="新建工程").click()
    chooser_info.value.set_files(str(FIXTURE))
    wait_for_workbench(page, mode)


def add_waypoints(page, count):
    page.get_by_role("button", name="添加导航点").click()
    map_box = page.locator(".map2d-view").bounding_box()
    assert map_box
    for index in range(count):
        page.mouse.click(
            map_box["x"] + map_box["width"] * (0.44 + index * 0.1),
            map_box["y"] + map_box["height"] * 0.52,
        )
    assert page.locator(".waypoint-marker").count() == count


def set_color_mode(page, expected):
    button = page.get_by_role("button", name="切换点云颜色模式")
    for _ in range(3):
        if button.get_attribute("data-color-mode") == expected:
            return
        button.click()
    assert button.get_attribute("data-color-mode") == expected


def return_home(page):
    page.get_by_role("button", name="返回主页面").click()
    page.wait_for_url(f"{BASE_URL}/")
    wait_for_home(page)


def continue_mode(page, mode):
    page.get_by_role("radio", name="独立示教" if mode == "independent" else "地图示教").click()
    page.get_by_role("button", name="继续工作").first.click()
    wait_for_workbench(page, mode)


def run():
    errors = []
    with sync_playwright() as playwright:
        launch_options = {"headless": True}
        system_chrome = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        if system_chrome.exists():
            launch_options["executable_path"] = str(system_chrome)
        browser = playwright.chromium.launch(**launch_options)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(30_000)
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        page.goto(f"{BASE_URL}/", wait_until="networkidle")
        wait_for_home(page)

        create_project(page, "map")
        add_waypoints(page, 1)
        set_color_mode(page, "source")
        return_home(page)
        home = page.locator('[data-app-page="home"]')
        assert home.get_attribute("data-map-workspace") == "cached"
        assert home.get_attribute("data-independent-workspace") == "empty"

        create_project(page, "independent")
        assert page.locator(".visual-workspace").get_attribute(
            "data-workspace-layout"
        ) == "spatial-only"
        assert page.locator(".panel-2d").count() == 0
        set_color_mode(page, "white")
        return_home(page)
        assert home.get_attribute("data-map-workspace") == "cached"
        assert home.get_attribute("data-independent-workspace") == "cached"

        continue_mode(page, "map")
        assert page.locator(".waypoint-marker").count() == 1
        assert page.get_by_role("button", name="切换点云颜色模式").get_attribute(
            "data-color-mode"
        ) == "source"
        assert page.locator(".three-canvas").get_attribute("data-coordinate-frame") == "map"

        return_home(page)
        continue_mode(page, "independent")
        assert page.locator(".panel-2d").count() == 0
        assert page.locator(".map2d-view").count() == 0
        assert page.get_by_role("button", name="切换点云颜色模式").get_attribute(
            "data-color-mode"
        ) == "white"
        assert page.locator(".three-canvas").get_attribute(
            "data-coordinate-frame"
        ) == "virtual_origin"

        page.reload(wait_until="networkidle")
        wait_for_workbench(page, "independent")
        assert page.locator(".panel-2d").count() == 0
        return_home(page)
        assert home.get_attribute("data-map-workspace") == "cached"
        assert home.get_attribute("data-independent-workspace") == "cached"

        workspace_keys = page.evaluate(
            """
            async () => {
              const database = await new Promise((resolve, reject) => {
                const request = indexedDB.open('atlas-route-studio', 1);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              });
              const keys = await new Promise((resolve, reject) => {
                const transaction = database.transaction('workspace-session', 'readonly');
                const request = transaction.objectStore('workspace-session').getAllKeys();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              });
              database.close();
              return keys;
            }
            """
        )
        assert "workspace-map:map" in workspace_keys
        assert "workspace-config:map" in workspace_keys
        assert "workspace-map:independent" in workspace_keys
        assert "workspace-config:independent" in workspace_keys
        assert "map" not in workspace_keys
        assert "config" not in workspace_keys
        page.wait_for_timeout(500)
        page.screenshot(path="/tmp/atlas-dual-workspaces.png", full_page=True)

        print("map_cache=1 waypoint")
        print("independent_cache=spatial-only")
        print("page_errors=", errors)
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
