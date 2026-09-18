import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990").rstrip("/")
FIXTURE = Path(__file__).parent / "fixtures" / "rotation-map.ply"


def wait_for_home(page):
    page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for(
        timeout=30_000
    )


def wait_for_workbench(page):
    page.wait_for_url(f"{BASE_URL}/workbench")
    page.locator('.app-shell[data-app-page="workbench"][aria-hidden="false"]').wait_for()
    page.locator(".loading-curtain").wait_for(state="hidden", timeout=30_000)


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(30_000)
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        page.goto(f"{BASE_URL}/", wait_until="networkidle")
        wait_for_home(page)
        home = page.locator('[data-app-page="home"]')
        assert home.get_attribute("data-selected-teaching-mode") == "map"
        assert home.get_attribute("data-has-workspace") == "false"
        assert page.get_by_role("radio", name="地图示教").get_attribute(
            "aria-checked"
        ) == "true"
        assert page.get_by_role("button", name="新建工程").is_enabled()
        assert page.get_by_role("button", name="加载工程").is_enabled()

        page.get_by_role("radio", name="独立示教").click()
        assert home.get_attribute("data-selected-teaching-mode") == "independent"
        assert page.get_by_role("radio", name="独立示教").get_attribute(
            "aria-checked"
        ) == "true"

        with page.expect_file_chooser() as chooser_info:
            page.get_by_role("button", name="新建工程").click()
        chooser_info.value.set_files(str(FIXTURE))
        wait_for_workbench(page)
        page.locator(".projection-status").wait_for(state="hidden")
        assert page.locator('.app-shell[data-app-page="workbench"]').get_attribute(
            "data-teaching-space-mode"
        ) == "independent"
        assert page.locator(".three-canvas").get_attribute(
            "data-coordinate-frame"
        ) == "virtual_origin"

        page.get_by_role("button", name="返回主页面").click()
        page.wait_for_url(f"{BASE_URL}/")
        wait_for_home(page)
        assert home.get_attribute("data-has-workspace") == "true"
        assert home.get_attribute("data-selected-teaching-mode") == "independent"
        assert "rotation-map.ply" in page.locator(".start-page__resume").inner_text()

        page.wait_for_timeout(700)
        page.reload(wait_until="networkidle")
        wait_for_home(page)
        page.wait_for_timeout(500)
        assert home.get_attribute("data-has-workspace") == "true"
        assert home.get_attribute("data-selected-teaching-mode") == "independent"
        assert "rotation-map.ply" in page.locator(".start-page__resume").inner_text()
        page.screenshot(path="/tmp/atlas-start-page-with-workspace.png", full_page=True)

        page.get_by_role("button", name="继续工作").first.click()
        wait_for_workbench(page)
        assert page.locator(".three-canvas").get_attribute(
            "data-geometry-source"
        ) == "session-cache"

        page.get_by_role("button", name="打开示教数据管理页").click()
        page.wait_for_url(f"{BASE_URL}/teaching-data")
        page.locator('[data-page="teaching-data"]').wait_for()
        assert page.get_by_role("button", name="主页面").is_visible()
        assert page.get_by_role("button", name="继续工作").count() >= 1

        page.get_by_role("button", name="主页面").click()
        page.wait_for_url(f"{BASE_URL}/")
        wait_for_home(page)
        page.get_by_role("button", name="继续工作").first.click()
        wait_for_workbench(page)

        print("final_url=", page.url)
        print("page_errors=", errors)
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
