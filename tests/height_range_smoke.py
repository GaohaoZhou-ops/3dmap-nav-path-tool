import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
FIXTURE = Path(__file__).parent / "fixtures" / "rotation-map.ply"


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.set_default_timeout(30_000)
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        page.goto(BASE_URL)
        page.wait_for_load_state("networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.locator('input[type="file"][accept=".ply"]').set_input_files(str(FIXTURE))
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.locator(".projection-status").wait_for(state="hidden")

        rail = page.locator(".height-range__rail")
        slider = page.get_by_role("slider", name="截面中心高度")

        def number(attribute):
            return float(slider.get_attribute(attribute))

        def assert_handle_at(expected_percentage, edge):
            actual_percentage = number("data-track-percentage")
            assert abs(actual_percentage - expected_percentage) < 0.01
            rail_box = rail.bounding_box()
            handle_box = slider.bounding_box()
            assert rail_box and handle_box
            handle_center = handle_box["y"] + handle_box["height"] / 2
            rail_edge = rail_box["y"] if edge == "top" else rail_box["y"] + rail_box["height"]
            assert abs(handle_center - rail_edge) <= 1.5

        center_min = number("aria-valuemin")
        center_max = number("aria-valuemax")
        assert center_min < center_max

        # The suggested slice already touches the map's lower Z boundary. Its
        # handle must therefore be at the physical bottom of the rail.
        assert abs(number("data-slice-min") - 0.0) < 0.001
        assert_handle_at(0.0, "bottom")

        rail_box = rail.bounding_box()
        handle_box = slider.bounding_box()
        assert rail_box and handle_box
        page.mouse.move(
            handle_box["x"] + handle_box["width"] / 2,
            handle_box["y"] + handle_box["height"] / 2,
        )
        page.mouse.down()
        page.mouse.move(
            rail_box["x"] + rail_box["width"] / 2,
            rail_box["y"] - 24,
            steps=5,
        )
        page.mouse.up()

        assert abs(number("aria-valuenow") - center_max) < 0.001
        assert abs(number("data-slice-max") - 4.4) < 0.001
        assert_handle_at(100.0, "top")

        handle_box = slider.bounding_box()
        assert handle_box
        page.mouse.move(
            handle_box["x"] + handle_box["width"] / 2,
            handle_box["y"] + handle_box["height"] / 2,
        )
        page.mouse.down()
        page.mouse.move(
            rail_box["x"] + rail_box["width"] / 2,
            rail_box["y"] + rail_box["height"] + 24,
            steps=5,
        )
        page.mouse.up()

        assert abs(number("aria-valuenow") - center_min) < 0.001
        assert abs(number("data-slice-min") - 0.0) < 0.001
        assert_handle_at(0.0, "bottom")

        slider.press("End")
        assert_handle_at(100.0, "top")
        slider.press("Home")
        assert_handle_at(0.0, "bottom")
        page.locator(".projection-status").wait_for(state="hidden")
        page.screenshot(path="/tmp/atlas-height-range-bottom.png", full_page=True)

        print("center_range=", center_min, "->", center_max)
        print("bottom_slice=", number("data-slice-min"), "->", number("data-slice-max"))
        print("page_errors=", errors)
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
