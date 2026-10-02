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
    shell = page.locator(
        f'.app-shell[data-app-page="workbench"][data-teaching-space-mode="{mode}"][aria-hidden="false"]'
    )
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
    page.get_by_role("button", name="显示设置", exact=True).click()
    button = page.get_by_role("button", name="切换点云颜色模式")
    for _ in range(3):
        if button.get_attribute("data-color-mode") == expected:
            page.get_by_role("button", name="关闭显示设置", exact=True).click()
            return
        button.click()
    assert button.get_attribute("data-color-mode") == expected
    page.get_by_role("button", name="关闭显示设置", exact=True).click()


def return_home(page):
    page.get_by_role("button", name="返回主页面").click()
    page.wait_for_url(f"{BASE_URL}/")
    wait_for_home(page)


def continue_mode(page, mode):
    page.get_by_role("radio", name="独立示教" if mode == "independent" else "地图示教").click()
    page.get_by_role("button", name="继续工作").first.click()
    wait_for_workbench(page, mode)


def switch_mode(page, mode):
    label = "独立示教" if mode == "independent" else "地图示教"
    button = page.get_by_role("button", name=f"切换到{label}", exact=True)
    assert button.inner_text() == label
    button.click()


def run():
    errors = []
    unexpected_dialogs = []
    file_choosers = []
    with sync_playwright() as playwright:
        launch_options = {"headless": True}
        system_chrome = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        if system_chrome.exists():
            launch_options["executable_path"] = str(system_chrome)
        browser = playwright.chromium.launch(**launch_options)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(30_000)
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("filechooser", lambda chooser: file_choosers.append(chooser))
        page.on("dialog", lambda dialog: (unexpected_dialogs.append(dialog.message), dialog.dismiss()))

        page.goto(f"{BASE_URL}/", wait_until="networkidle")
        wait_for_home(page)

        create_project(page, "map")
        add_waypoints(page, 1)
        set_color_mode(page, "source")
        switch_mode(page, "independent")
        wait_for_home(page)
        home = page.locator('[data-app-page="home"]')
        assert home.get_attribute("data-selected-teaching-mode") == "independent"
        assert home.get_attribute("data-map-workspace") == "cached"
        assert home.get_attribute("data-independent-workspace") == "empty"
        assert len(file_choosers) == 1

        create_project(page, "independent")
        assert page.locator(".visual-workspace").get_attribute(
            "data-workspace-layout"
        ) == "spatial-only"
        assert page.locator(".panel-2d").count() == 0
        set_color_mode(page, "white")
        switch_mode(page, "map")
        wait_for_workbench(page, "map")
        page.locator(".waypoint-marker").wait_for()
        assert page.locator(".waypoint-marker").count() == 1
        page.get_by_role("button", name="显示设置", exact=True).click()
        assert page.get_by_role("button", name="切换点云颜色模式").get_attribute(
            "data-color-mode"
        ) == "source"
        assert page.locator(".three-canvas").get_attribute("data-coordinate-frame") == "map"

        page.get_by_role("button", name="关闭显示设置", exact=True).click()
        switch_mode(page, "independent")
        wait_for_workbench(page, "independent")
        assert page.locator(".panel-2d").count() == 0
        assert page.locator(".map2d-view").count() == 0
        page.get_by_role("button", name="显示设置", exact=True).click()
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
        continue_mode(page, "map")
        page.locator(".waypoint-marker").wait_for()
        assert page.locator(".waypoint-marker").count() == 1
        return_home(page)

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
        assert len(file_choosers) == 2
        assert not unexpected_dialogs

        # The reverse empty-target case must select the map entry without
        # changing or dropping the current independent workspace.
        empty_target = browser.new_page(viewport={"width": 1440, "height": 900})
        empty_target.on("pageerror", lambda exc: errors.append(str(exc)))
        empty_target.on("filechooser", lambda chooser: file_choosers.append(chooser))
        empty_target.goto(f"{BASE_URL}/", wait_until="networkidle")
        wait_for_home(empty_target)
        create_project(empty_target, "independent")
        switch_mode(empty_target, "map")
        wait_for_home(empty_target)
        empty_home = empty_target.locator('[data-app-page="home"]')
        assert empty_home.get_attribute("data-selected-teaching-mode") == "map"
        assert empty_home.get_attribute("data-map-workspace") == "empty"
        assert empty_home.get_attribute("data-independent-workspace") == "cached"
        assert len(file_choosers) == 3
        continue_mode(empty_target, "independent")
        assert empty_target.locator(".three-canvas").get_attribute("data-coordinate-frame") == "virtual_origin"
        empty_target.close()
        page.wait_for_timeout(500)
        page.screenshot(path="/tmp/atlas-dual-workspaces.png", full_page=True)

        print("map_cache=1 waypoint")
        print("independent_cache=spatial-only")
        print("page_errors=", errors)
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
