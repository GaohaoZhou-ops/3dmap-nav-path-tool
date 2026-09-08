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
        center_slider = page.get_by_role("slider", name="截面中心高度")
        span_slider = page.get_by_role("slider", name="截面高度跨度")

        def number(attribute):
            return float(center_slider.get_attribute(attribute))

        def current_span():
            return number("data-slice-max") - number("data-slice-min")

        def set_span(value):
            span_slider.evaluate(
                """
                (element, nextValue) => {
                  const setter = Object.getOwnPropertyDescriptor(
                    HTMLInputElement.prototype,
                    'value',
                  ).set;
                  setter.call(element, String(nextValue));
                  element.dispatchEvent(new Event('input', {bubbles: true}));
                  element.dispatchEvent(new Event('change', {bubbles: true}));
                }
                """,
                value,
            )

        def settle_projection():
            page.wait_for_timeout(220)
            page.locator(".projection-status").wait_for(state="hidden")

        def assert_handle_at(expected_percentage, edge):
            actual_percentage = number("data-track-percentage")
            assert abs(actual_percentage - expected_percentage) < 0.01
            rail_box = rail.bounding_box()
            handle_box = center_slider.bounding_box()
            assert rail_box and handle_box
            handle_center = handle_box["y"] + handle_box["height"] / 2
            rail_edge = rail_box["y"] if edge == "top" else rail_box["y"] + rail_box["height"]
            assert abs(handle_center - rail_edge) <= 1.5

        assert center_slider.count() == 1
        assert span_slider.count() == 1
        assert page.locator(".height-range__handle").count() == 1
        assert page.locator(".height-range__inputs input").count() == 2
        controller = page.locator(".height-range")
        assert controller.get_attribute("data-slice-mode") == "range"
        cloud_min = float(controller.get_attribute("data-cloud-min"))
        cloud_max = float(controller.get_attribute("data-cloud-max"))
        control_min = float(controller.get_attribute("data-control-min"))
        control_max = float(controller.get_attribute("data-control-max"))
        control_margin = float(controller.get_attribute("data-control-margin"))
        assert abs(cloud_min - 0.0) < 0.001
        assert abs(cloud_max - 4.4) < 0.001
        assert abs(control_margin - (cloud_max - cloud_min) * 0.05) < 0.001
        assert control_min < cloud_min
        assert control_max > cloud_max
        assert abs((cloud_min - control_min) - control_margin) < 0.001
        assert abs((control_max - cloud_max) - control_margin) < 0.001
        assert page.locator(".height-range__cloud-limit").count() == 2

        initial_center = number("aria-valuenow")
        initial_span = current_span()
        assert abs(number("data-slice-min") - 0.0) < 0.001
        assert 0 < initial_span < 4.4
        assert abs(float(span_slider.input_value()) - initial_span) < 0.001

        # The second bar changes thickness while keeping the current center
        # stable whenever the requested range fits inside the map bounds.
        set_span(1.2)
        settle_projection()
        adjusted_span = float(span_slider.input_value())
        assert abs(adjusted_span - 1.2) < 0.03
        assert abs(current_span() - adjusted_span) < 0.001
        assert abs(number("aria-valuenow") - initial_center) < 0.001

        three_canvas = page.locator(".three-canvas")
        vector_map = page.get_by_label("二维矢量点云截面")
        map2d = page.locator(".map2d-view")
        assert three_canvas.get_attribute("data-slice-mode") == "range"
        assert three_canvas.get_attribute("data-slice-geometry") == "box"
        assert abs(float(three_canvas.get_attribute("data-slice-span")) - adjusted_span) < 0.001
        assert vector_map.get_attribute("data-slice-mode") == "range"
        assert map2d.get_attribute("data-slice-mode") == "range"
        assert abs(float(vector_map.get_attribute("data-slice-span")) - adjusted_span) < 0.001

        rail_box = rail.bounding_box()
        handle_box = center_slider.bounding_box()
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

        assert abs(number("data-slice-max") - control_max) < 0.001
        assert number("data-slice-max") > cloud_max
        assert abs(current_span() - adjusted_span) < 0.001
        assert_handle_at(100.0, "top")

        handle_box = center_slider.bounding_box()
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

        assert abs(number("data-slice-min") - control_min) < 0.001
        assert number("data-slice-min") < cloud_min
        assert abs(current_span() - adjusted_span) < 0.001
        assert_handle_at(0.0, "bottom")

        center_slider.press("End")
        assert_handle_at(100.0, "top")
        center_slider.press("Home")
        assert_handle_at(0.0, "bottom")

        # A full-control-domain span includes both margins and collapses center
        # travel to the midpoint without changing the point cloud's true bounds.
        span_slider.press("End")
        settle_projection()
        assert abs(number("data-slice-min") - control_min) < 0.001
        assert abs(number("data-slice-max") - control_max) < 0.001
        assert abs(number("aria-valuemin") - 2.2) < 0.001
        assert abs(number("aria-valuemax") - 2.2) < 0.001
        assert abs(number("data-track-percentage") - 50.0) < 0.001

        set_span(1.2)
        center_slider.press("Home")
        settle_projection()
        page.screenshot(path="/tmp/atlas-height-span.png", full_page=True)

        print("initial_span=", initial_span, "adjusted_span=", adjusted_span)
        print("control_bounds=", control_min, "->", control_max)
        print("bottom_slice=", number("data-slice-min"), "->", number("data-slice-max"))
        print("page_errors=", errors)
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
