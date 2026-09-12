import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:22063")
FIXTURE = Path(__file__).parent / "fixtures" / "rotation-map.ply"


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(30_000)
        page.on("pageerror", lambda error: errors.append(str(error)))

        page.goto(BASE_URL, wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")

        inspector = page.locator(".inspector-panel")
        tabs = page.get_by_role("tablist", name="控制台子页")
        navigation_tab = page.get_by_role("tab", name="路径与导航")
        project_tab = page.get_by_role("tab", name="工程配置")
        teaching_tab = page.get_by_role("tab", name="虚拟示教与相机")

        assert tabs.get_by_role("tab").count() == 3
        assert inspector.get_attribute("data-active-page") == "project"
        assert project_tab.get_attribute("aria-selected") == "true"
        assert navigation_tab.get_attribute("aria-selected") == "false"
        assert teaching_tab.get_attribute("aria-selected") == "false"
        assert page.get_by_role("tabpanel").get_attribute("id") == "inspector-page-project"
        assert page.locator(".project-overview").is_visible()
        assert page.get_by_label("导航点搜索").count() == 0
        assert page.get_by_label("虚拟示教", exact=True).count() == 0
        assert page.locator(".topbar").get_by_role(
            "button", name="导出 JSON", exact=True
        ).count() == 0
        assert page.locator(".topbar").get_by_role(
            "button", name="导出示教工程 JSON"
        ).count() == 0

        navigation_tab.click()
        assert inspector.get_attribute("data-active-page") == "navigation"
        assert navigation_tab.get_attribute("aria-selected") == "true"
        assert page.get_by_role("tabpanel").get_attribute("id") == "inspector-page-navigation"
        assert page.get_by_label("导航点搜索").is_visible()
        assert page.locator(".connectivity-card").is_visible()
        assert page.locator(".project-overview").count() == 0

        # Tabs follow the standard left/right/home/end keyboard model.
        navigation_tab.focus()
        page.keyboard.press("ArrowRight")
        assert inspector.get_attribute("data-active-page") == "project"
        assert project_tab.get_attribute("aria-selected") == "true"
        page.wait_for_function(
            "document.activeElement?.id === 'inspector-tab-project'"
        )
        page.keyboard.press("ArrowRight")
        assert inspector.get_attribute("data-active-page") == "teaching"
        assert teaching_tab.get_attribute("aria-selected") == "true"
        assert page.get_by_label("虚拟示教", exact=True).is_visible()
        export_button = page.get_by_role(
            "button", name="导出示教工程 JSON", exact=True
        )
        assert export_button.is_disabled()
        assert page.get_by_label("Zivid 2 M70 相机视图").count() == 0
        assert page.locator(".project-overview").count() == 0
        assert page.get_by_label("导航点搜索").count() == 0

        page.locator('input[type="file"][accept=".ply"]').set_input_files(str(FIXTURE))
        page.locator(".loading-curtain").wait_for(state="hidden")
        assert inspector.get_attribute("data-active-page") == "teaching"
        assert export_button.is_enabled()

        # A selection from either map must reveal its editor on the navigation page.
        page.get_by_role("button", name="添加导航点").click()
        map_box = page.locator(".map2d-view").bounding_box()
        assert map_box
        page.mouse.click(
            map_box["x"] + map_box["width"] * 0.43,
            map_box["y"] + map_box["height"] * 0.52,
        )
        page.wait_for_function(
            "document.querySelector('.inspector-panel')?.dataset.activePage === 'navigation'"
        )
        assert navigation_tab.get_attribute("aria-selected") == "true"
        assert page.get_by_role("heading", name="P01", exact=True).is_visible()
        assert page.get_by_role("button", name="返回路径与导航").is_visible()

        teaching_tab.click()
        with page.expect_download() as download_info:
            export_button.click()
        download = download_info.value
        exported = json.loads(Path(download.path()).read_text())
        assert download.suggested_filename.startswith("virtual-teaching-")
        assert len(exported["waypoints"]) == 1
        assert exported["virtualTeaching"]["tasks"] == []
        page.locator('input[type="file"][accept*="json"]').set_input_files(
            str(Path(download.path()))
        )
        page.get_by_text("工程配置已加载", exact=False).wait_for()
        assert page.locator(".waypoint-marker").count() == 1
        page.screenshot(path="/tmp/atlas-teaching-export.png", full_page=True)

        project_tab.click()
        assert page.locator(".project-overview").is_visible()
        assert "rotation-map.ply" in page.locator(".project-overview").inner_text()
        page.screenshot(path="/tmp/atlas-inspector-pagination.png", full_page=True)

        dimensions = page.evaluate(
            "({sw:document.body.scrollWidth,cw:document.body.clientWidth,"
            "sh:document.body.scrollHeight,ch:document.body.clientHeight})"
        )
        assert dimensions["sw"] == dimensions["cw"]
        assert dimensions["sh"] == dimensions["ch"]
        assert not errors, errors
        browser.close()


if __name__ == "__main__":
    run()
