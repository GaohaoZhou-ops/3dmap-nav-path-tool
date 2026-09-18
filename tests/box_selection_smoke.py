import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
FIXTURE = Path(__file__).parent / "fixtures" / "rotation-map.ply"


def element_center(locator):
    box = locator.bounding_box()
    assert box
    return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2


def path_midpoint(path):
    return path.evaluate(
        """
        (element) => {
          const local = element.getPointAtLength(element.getTotalLength() / 2);
          const screen = new DOMPoint(local.x, local.y).matrixTransform(element.getScreenCTM());
          return {x: screen.x, y: screen.y};
        }
        """
    )


def drag_box(page, start, end, screenshot=None):
    page.mouse.move(*start)
    page.mouse.down()
    page.mouse.move(*end, steps=5)
    map_view = page.locator(".map2d-view")
    assert map_view.get_attribute("data-box-selection-state") == "dragging"
    assert page.locator(".map-selection-marquee").count() == 1
    if screenshot:
        page.screenshot(path=screenshot, full_page=True)
    page.mouse.up()


def run():
    errors = []
    console_errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(30_000)
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )

        page.goto(f"{BASE_URL.rstrip('/')}/workbench")
        page.wait_for_load_state("networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.locator('input[type="file"][accept=".ply"]').set_input_files(str(FIXTURE))
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.locator(".projection-status").wait_for(state="hidden")

        map_view = page.locator(".map2d-view")
        map_box = map_view.bounding_box()
        assert map_box
        center_x = map_box["x"] + map_box["width"] / 2
        center_y = map_box["y"] + map_box["height"] / 2

        page.get_by_role("button", name="添加导航点").click()
        for offset in (-150, 0, 150):
            page.mouse.click(center_x + offset, center_y)
        markers = page.locator(".waypoint-marker")
        assert markers.count() == 3

        page.get_by_role("button", name="连接路径").click()
        markers.nth(0).click()
        markers.nth(1).click()
        markers.nth(1).click()
        markers.nth(2).click()
        assert page.locator(".route-edge").count() == 2

        page.get_by_role("button", name="框选", exact=True).click()
        assert "mode-box" in (map_view.get_attribute("class") or "")
        assert map_view.get_attribute("data-delete-shortcut") == "Delete,Backspace"

        # A narrow frame around only the middle of the first curve must select
        # that path without requiring either endpoint to be inside the box.
        first_path = page.locator(".route-edge__visible").nth(0)
        midpoint = path_midpoint(first_path)
        drag_box(
            page,
            (midpoint["x"] - 34, midpoint["y"] - 22),
            (midpoint["x"] + 34, midpoint["y"] + 22),
            "/tmp/atlas-box-selection-drag.png",
        )
        assert map_view.get_attribute("data-box-selection-state") == "selected"
        assert map_view.get_attribute("data-box-selected-waypoint-count") == "0"
        assert map_view.get_attribute("data-box-selected-edge-count") == "1"
        assert page.locator(".route-edge.is-box-selected").count() == 1
        selection_summary = page.get_by_label("框选结果")
        assert "0 点 · 1 路径" in selection_summary.inner_text()
        page.screenshot(path="/tmp/atlas-box-selected-path.png", full_page=True)

        page.keyboard.press("Delete")
        assert page.locator(".route-edge").count() == 1
        assert markers.count() == 3
        assert map_view.get_attribute("data-box-selection-state") == "idle"
        assert selection_summary.count() == 0

        # Select two waypoint bodies plus their remaining connecting path. The
        # delete operation must remove the points and cascade to that path.
        second_center = element_center(markers.nth(1))
        third_center = element_center(markers.nth(2))
        drag_box(
            page,
            (second_center[0] - 28, second_center[1] - 34),
            (third_center[0] + 28, third_center[1] + 34),
        )
        assert map_view.get_attribute("data-box-selected-waypoint-count") == "2"
        assert map_view.get_attribute("data-box-selected-edge-count") == "1"
        assert page.locator(".waypoint-marker.is-box-selected").count() == 2
        assert page.locator(".route-edge.is-box-selected").count() == 1
        assert "2 点 · 1 路径" in page.get_by_label("框选结果").inner_text()
        page.screenshot(path="/tmp/atlas-box-selected-mixed.png", full_page=True)

        page.keyboard.press("Backspace")
        assert markers.count() == 1
        assert page.locator(".route-edge").count() == 0
        assert map_view.get_attribute("data-box-selection-state") == "idle"

        # A regular single-object selection also honors the direct Delete key.
        page.get_by_role("button", name="选择 / 漫游", exact=True).click()
        markers.first.click()
        assert "is-selected" in (markers.first.get_attribute("class") or "")
        waypoint_name = page.get_by_label("导航点名称")
        waypoint_name.focus()
        page.keyboard.press("Delete")
        assert markers.count() == 1
        waypoint_name.blur()
        page.keyboard.press("Delete")
        assert markers.count() == 0

        print("box_selection=path-only -> mixed -> single delete")
        print("page_errors=", errors)
        assert not errors
        assert not console_errors
        browser.close()


if __name__ == "__main__":
    run()
