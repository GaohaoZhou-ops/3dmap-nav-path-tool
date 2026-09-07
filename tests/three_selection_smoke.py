import math
import os
import re
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
FIXTURE = Path(__file__).parent / "fixtures" / "rotation-map.ply"
POSE_PATTERN = re.compile(
    r"X\s+(-?\d+(?:\.\d+)?)\s+/\s+Y\s+(-?\d+(?:\.\d+)?)\s+/\s+Z\s+(-?\d+(?:\.\d+)?)"
)


def normalize(vector):
    length = math.sqrt(sum(value * value for value in vector))
    assert length > 1e-12
    return tuple(value / length for value in vector)


def cross(left, right):
    return (
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    )


def dot(left, right):
    return sum(a * b for a, b in zip(left, right))


def parse_pose(marker):
    match = POSE_PATTERN.search(marker.get_attribute("title") or "")
    assert match
    return tuple(float(value) for value in match.groups())


def project_to_canvas(canvas, pose):
    box = canvas.bounding_box()
    assert box
    camera = tuple(
        float(canvas.get_attribute(f"data-camera-{axis}")) for axis in ("x", "y", "z")
    )
    target = tuple(
        float(canvas.get_attribute(f"data-target-{axis}")) for axis in ("x", "y", "z")
    )
    forward = normalize(tuple(target[index] - camera[index] for index in range(3)))
    right = normalize(cross(forward, (0.0, 0.0, 1.0)))
    camera_up = normalize(cross(right, forward))
    relative = tuple(pose[index] - camera[index] for index in range(3))
    depth = dot(relative, forward)
    assert depth > 0
    tangent = math.tan(math.radians(float(canvas.get_attribute("data-camera-fov"))) / 2)
    zoom = float(canvas.get_attribute("data-optical-zoom"))
    aspect = box["width"] / box["height"]
    ndc_x = dot(relative, right) * zoom / (depth * tangent * aspect)
    ndc_y = dot(relative, camera_up) * zoom / (depth * tangent)
    return (
        box["x"] + (ndc_x + 1) * box["width"] / 2,
        box["y"] + (1 - ndc_y) * box["height"] / 2,
    )


def run():
    errors = []
    console_errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.set_default_timeout(30_000)
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )

        page.goto(BASE_URL)
        page.wait_for_load_state("networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.locator('input[type="file"][accept=".ply"]').set_input_files(str(FIXTURE))
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.locator(".projection-status").wait_for(state="hidden")

        page.get_by_role("button", name="添加导航点").click()
        map_box = page.locator(".map2d-view").bounding_box()
        assert map_box
        center_x = map_box["x"] + map_box["width"] / 2
        center_y = map_box["y"] + map_box["height"] / 2
        page.mouse.click(center_x - 65, center_y)
        page.mouse.click(center_x + 65, center_y)
        markers = page.locator(".waypoint-marker")
        assert markers.count() == 2
        poses = [parse_pose(markers.nth(index)) for index in range(2)]
        canvas = page.locator(".three-canvas")
        assert canvas.get_attribute("data-waypoint-visibility-mode") == "screen-clamped-lod"
        assert canvas.get_attribute("data-minimum-waypoint-screen-diameter") == "8"
        assert canvas.get_attribute("data-waypoint-visual-status") == "visible"
        page.wait_for_function(
            "canvas => Number(canvas.dataset.smallestWaypointScreenDiameter) >= 7.9",
            arg=canvas.element_handle(),
        )

        # The inspector search is a closed list sourced only from this map.
        # Selecting a result restores hidden 3D markers and highlights the same
        # waypoint in both views with a breathing animation.
        waypoint_search = page.get_by_label("搜索导航点")
        assert waypoint_search.locator("option").count() == 3
        first_waypoint_id = waypoint_search.locator("option").nth(1).get_attribute("value")
        assert first_waypoint_id
        page.get_by_role("button", name="隐藏3D路径点").click()
        assert canvas.get_attribute("data-waypoints-visible") == "false"
        assert canvas.get_attribute("data-waypoint-visual-status") == "hidden-by-user"
        assert "点已隐藏" in page.get_by_role("button", name="显示3D路径点").inner_text()
        waypoint_search.select_option(first_waypoint_id)
        assert canvas.get_attribute("data-waypoints-visible") == "true"
        assert canvas.get_attribute("data-selected-waypoint-pulse-state") == "active"
        map_view = page.locator(".map2d-view")
        page.wait_for_function(
            "([three, two]) => three.dataset.synchronizedFocusState === 'settled' && two.dataset.synchronizedFocusState === 'settled'",
            arg=[canvas.element_handle(), map_view.element_handle()],
        )
        assert canvas.get_attribute("data-synchronized-focus-type") == "waypoint"
        assert map_view.get_attribute("data-synchronized-focus-type") == "waypoint"
        assert canvas.get_attribute("data-synchronized-focus-id") == first_waypoint_id
        assert map_view.get_attribute("data-synchronized-focus-id") == first_waypoint_id
        vector_canvas = page.get_by_label("二维矢量点云截面")
        assert abs(float(vector_canvas.get_attribute("data-view-center-x")) - poses[0][0]) < 0.01
        assert abs(float(vector_canvas.get_attribute("data-view-center-y")) - poses[0][1]) < 0.01
        selected_marker = page.locator(
            f'.waypoint-marker[data-waypoint-id="{first_waypoint_id}"]'
        )
        assert "is-selected" in (selected_marker.get_attribute("class") or "")
        assert selected_marker.evaluate("node => getComputedStyle(node).animationName") == (
            "waypoint-selected-pulse"
        )
        page.wait_for_function(
            "canvas => Number.isFinite(Number(canvas.dataset.selectedWaypointPulse))",
            arg=canvas.element_handle(),
        )
        pulse_before = float(canvas.get_attribute("data-selected-waypoint-pulse"))
        page.wait_for_timeout(260)
        pulse_after = float(canvas.get_attribute("data-selected-waypoint-pulse"))
        assert abs(pulse_after - pulse_before) > 0.005
        page.screenshot(path="/tmp/atlas-waypoint-search-pulse.png", full_page=True)
        page.get_by_role("button", name="返回工程总览").click()
        page.get_by_role("button", name="适配全图").click()
        page.wait_for_timeout(80)

        page.get_by_role("button", name="连接路径").click()
        markers.nth(0).click()
        markers.nth(1).click()
        assert page.locator(".route-edge").count() == 1
        assert page.get_by_role("heading", name="路径参数").is_visible()

        assert canvas.get_attribute("data-route-edge-count") == "1"
        assert canvas.get_attribute("data-rendered-waypoint-count") == "2"

        page.get_by_role("button", name="返回工程总览").click()
        page.locator(".route-index__item").first.click()
        page.wait_for_function(
            "([three, two]) => three.dataset.synchronizedFocusState === 'settled' && two.dataset.synchronizedFocusState === 'settled'",
            arg=[canvas.element_handle(), map_view.element_handle()],
        )
        focused_edge_id = canvas.get_attribute("data-synchronized-focus-id")
        assert focused_edge_id
        assert canvas.get_attribute("data-synchronized-focus-type") == "edge"
        assert map_view.get_attribute("data-synchronized-focus-type") == "edge"
        assert map_view.get_attribute("data-synchronized-focus-id") == focused_edge_id
        assert abs(float(vector_canvas.get_attribute("data-view-center-x")) - (
            poses[0][0] + poses[1][0]
        ) / 2) < 0.01
        assert abs(float(vector_canvas.get_attribute("data-view-center-y")) - (
            poses[0][1] + poses[1][1]
        ) / 2) < 0.01
        page.get_by_role("button", name="返回工程总览").click()
        point_screen = project_to_canvas(canvas, poses[0])
        page.mouse.move(*point_screen)
        page.wait_for_timeout(80)
        assert canvas.get_attribute("data-hover-pick-type") == "waypoint"
        page.mouse.click(*point_screen)
        assert canvas.get_attribute("data-last-pick-type") == "waypoint"
        assert page.get_by_role("heading", name="P01", exact=True).is_visible()
        z_input = page.locator(".property-editor .field-grid.three").first.locator("input").nth(2)
        adjusted_z = float(z_input.input_value()) + 0.25
        z_input.fill(f"{adjusted_z:.2f}")
        z_input.press("Enter")
        poses[0] = (poses[0][0], poses[0][1], adjusted_z)

        page.get_by_role("button", name="返回工程总览").click()
        midpoint = tuple((poses[0][index] + poses[1][index]) / 2 for index in range(3))
        edge_screen = project_to_canvas(canvas, midpoint)
        page.mouse.move(*edge_screen)
        page.wait_for_timeout(80)
        assert canvas.get_attribute("data-hover-pick-type") == "edge"
        page.mouse.click(*edge_screen)
        assert canvas.get_attribute("data-last-pick-type") == "edge"
        assert page.get_by_role("heading", name="路径参数").is_visible()

        distance = page.get_by_label("路径距离")
        straight = float(distance.get_attribute("data-straight-distance"))
        planar = float(distance.get_attribute("data-xy-distance"))
        assert straight > planar > 0
        assert abs(float(distance.get_attribute("data-vertical-delta")) - 0.25) < 1e-6
        assert "XY 距离已排除定位高度误差" in distance.inner_text()

        # Zooming far out activates marker LOD, retaining an 8 px minimum
        # diameter while the underlying sphere remains at 20% source volume.
        canvas_box = canvas.bounding_box()
        assert canvas_box
        page.mouse.move(
            canvas_box["x"] + canvas_box["width"] / 2,
            canvas_box["y"] + canvas_box["height"] / 2,
        )
        for _ in range(18):
            page.mouse.wheel(0, 500)
        page.wait_for_timeout(120)
        assert float(canvas.get_attribute("data-waypoint-max-lod-scale")) > 1
        assert float(canvas.get_attribute("data-smallest-waypoint-screen-diameter")) >= 7.9
        page.screenshot(path="/tmp/atlas-waypoint-overview-lod.png", full_page=True)

        page.screenshot(path="/tmp/atlas-3d-object-selection.png", full_page=True)
        print("3d_point_pick=", point_screen)
        print("3d_edge_pick=", edge_screen)
        print("distance_3d_xy=", straight, planar)
        print("page_errors=", errors)
        assert not errors
        assert not console_errors
        browser.close()


if __name__ == "__main__":
    run()
