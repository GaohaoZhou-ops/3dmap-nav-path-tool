import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")


def run():
    messages = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(30_000)
        page.on("console", lambda msg: messages.append(f"console:{msg.type}:{msg.text}"))
        page.on("pageerror", lambda exc: messages.append(f"pageerror:{exc}"))

        page.goto(BASE_URL)
        page.wait_for_load_state("networkidle")
        page.screenshot(path="/tmp/atlas-initial.png", full_page=True)
        assert page.locator(".viewport-panel").count() == 2
        assert page.locator(".inspector-panel").count() == 1

        page.get_by_role("button", name="示例地图").click()
        page.locator(".map-state-dot.online").wait_for(timeout=120_000)
        page.locator(".loading-curtain").wait_for(state="hidden", timeout=120_000)
        page.locator(".projection-status").wait_for(state="hidden", timeout=120_000)
        page.screenshot(path="/tmp/atlas-loaded.png", full_page=True)

        vector_map = page.get_by_label("二维矢量点云截面")
        assert vector_map.get_attribute("data-render-mode") == "vector-coordinate-webgl"
        assert vector_map.get_attribute("data-source-point-count") == "2685018"
        assert page.get_by_text("LIVE VECTOR", exact=True).is_visible()

        three_canvas = page.locator(".three-canvas")
        assert three_canvas.get_attribute("data-control-mode") == "free-trackball"
        assert three_canvas.get_attribute("data-zoom-mode") == "deep-detail"
        assert three_canvas.get_attribute("data-coordinate-origin") == "0,0,0"
        assert three_canvas.get_attribute("data-resolution-percent") == "100"
        assert three_canvas.get_attribute("data-render-point-count") == "2685018"
        assert three_canvas.get_attribute("data-color-mode") == "source"
        color_toggle = page.get_by_role("button", name="按高度渲染点云")
        color_toggle.click()
        page.wait_for_timeout(80)
        assert three_canvas.get_attribute("data-color-mode") == "height"
        assert color_toggle.get_attribute("aria-pressed") == "true"
        assert page.get_by_label("点云高程比例尺").is_visible()
        page.screenshot(path="/tmp/atlas-height-color.png", full_page=True)
        color_toggle.click()
        assert three_canvas.get_attribute("data-color-mode") == "source"
        projection_before_resolution = page.locator(".slice-badge strong").inner_text()
        decrease_resolution = page.get_by_role("button", name="降低点云分辨率")
        reset_resolution = page.get_by_role("button", name="重置点云分辨率")
        for _ in range(3):
            decrease_resolution.click()
        page.wait_for_timeout(80)
        assert three_canvas.get_attribute("data-resolution-percent") == "25"
        assert three_canvas.get_attribute("data-render-point-count") == "671255"
        assert page.locator(".slice-badge strong").inner_text() == projection_before_resolution
        page.screenshot(path="/tmp/atlas-performance-mode.png", full_page=True)
        reset_resolution.click()
        assert three_canvas.get_attribute("data-resolution-percent") == "100"
        assert three_canvas.get_attribute("data-render-point-count") == "2685018"
        assert page.get_by_role("button", name="平移", exact=True).is_visible()
        map_origin = page.get_by_role("button", name="二维坐标原点")
        assert map_origin.count() == 1
        assert "is-offscreen" in (map_origin.get_attribute("class") or "")
        map_origin.click()
        page.wait_for_timeout(80)
        assert "is-offscreen" not in (map_origin.get_attribute("class") or "")
        three_box = three_canvas.bounding_box()
        assert three_box
        drag_x = three_box["x"] + three_box["width"] * 0.48
        page.mouse.move(drag_x, three_box["y"] + three_box["height"] * 0.68)
        page.mouse.down()
        page.mouse.move(drag_x, three_box["y"] + three_box["height"] * 0.32, steps=2)
        page.mouse.up()
        page.get_by_role("button", name="平移", exact=True).click()
        assert three_canvas.get_attribute("data-interaction-mode") == "pan"
        page.mouse.move(
            three_box["x"] + three_box["width"] * 0.42,
            three_box["y"] + three_box["height"] * 0.52,
        )
        page.mouse.down()
        page.mouse.move(
            three_box["x"] + three_box["width"] * 0.56,
            three_box["y"] + three_box["height"] * 0.6,
            steps=2,
        )
        page.mouse.up()
        page.get_by_role("button", name="旋转", exact=True).click()

        height_bar = page.get_by_role("slider", name="截面中心高度")
        assert page.get_by_role("slider", name="截面中心高度").count() == 1
        assert page.locator(".height-range__handle").count() == 1
        height_input = page.locator(".height-range__inputs input")
        assert height_input.count() == 1
        changed_height = float(height_input.input_value()) - 0.2
        height_input.fill(f"{changed_height:.2f}")
        page.wait_for_timeout(300)
        page.locator(".projection-status").wait_for(state="hidden", timeout=120_000)
        assert abs(float(height_bar.get_attribute("aria-valuenow")) - changed_height) < 0.01

        page.get_by_role("button", name="添加导航点").click()
        map_box = page.locator(".map2d-view").bounding_box()
        assert map_box
        center_x = map_box["x"] + map_box["width"] / 2
        center_y = map_box["y"] + map_box["height"] / 2
        page.mouse.click(center_x - 105, center_y)
        page.mouse.click(center_x + 105, center_y)
        assert page.locator(".waypoint-marker").count() == 2

        page.get_by_role("button", name="连接路径").click()
        page.locator(".waypoint-marker").nth(0).click()
        page.locator(".waypoint-marker").nth(1).click()
        assert page.locator(".route-edge").count() == 1
        assert page.get_by_role("heading", name="路径参数").is_visible()
        assert page.locator(".property-editor .numeric-field input").count() == 4

        page.get_by_role("button", name="检测", exact=True).click()
        assert page.locator(".route-edge.unreachable").count() == 1
        assert page.get_by_text("1 条路径尚未形成回路", exact=True).is_visible()

        page.locator(".waypoint-marker").nth(1).click()
        page.locator(".waypoint-marker").nth(0).click()
        assert page.locator(".route-edge").count() == 2
        page.get_by_role("button", name="检测", exact=True).click()
        assert page.locator(".route-edge.connected").count() == 2
        assert page.get_by_text("全图强连通", exact=True).is_visible()
        page.screenshot(path="/tmp/atlas-connected.png", full_page=True)

        page.locator(".route-edge__hit").first.dispatch_event("dblclick")
        assert page.get_by_role("heading", name="路径参数").is_visible()

        with page.expect_download() as download_info:
            page.get_by_role("button", name="导出 JSON").click()
        download = download_info.value
        download_path = Path(download.path())
        assert download.suggested_filename.startswith("route-graph-")
        assert download_path.stat().st_size > 500
        exported = json.loads(download_path.read_text())
        exported_center = (
            exported["projection"]["minHeight"] + exported["projection"]["maxHeight"]
        ) / 2
        assert abs(exported_center - changed_height) < 0.001
        assert len(exported["waypoints"][0]["xzy"]) == 3
        assert len(exported["waypoints"][0]["rpy"]) == 3

        page.locator('input[type="file"][accept*="json"]').set_input_files(str(download_path))
        page.get_by_text("路径配置已加载", exact=False).wait_for()
        assert page.locator(".waypoint-marker").count() == 2
        assert page.locator(".route-edge").count() == 2

        initial_zoom_distance = float(three_canvas.get_attribute("data-camera-distance"))
        page.mouse.move(
            three_box["x"] + three_box["width"] * 0.5,
            three_box["y"] + three_box["height"] * 0.5,
        )
        for _ in range(35):
            page.mouse.wheel(0, -500)
            page.wait_for_timeout(18)
        detail_zoom_distance = float(three_canvas.get_attribute("data-camera-distance"))
        assert detail_zoom_distance < initial_zoom_distance * 0.01
        for _ in range(5):
            page.mouse.wheel(0, -500)
            page.wait_for_timeout(18)
        continued_zoom_distance = float(three_canvas.get_attribute("data-camera-distance"))
        assert continued_zoom_distance < detail_zoom_distance * 0.75
        page.screenshot(path="/tmp/atlas-example-deep-zoom.png", full_page=True)

        dimensions = page.evaluate(
            "({sw:document.body.scrollWidth,cw:document.body.clientWidth,"
            "sh:document.body.scrollHeight,ch:document.body.clientHeight})"
        )
        print("dimensions=", dimensions)
        print("map_points=", page.locator(".map-identity em").inner_text())
        print("projection=", page.locator(".slice-badge strong").inner_text())
        print("waypoints=", page.locator(".waypoint-marker").count())
        print("edges=", page.locator(".route-edge").count())
        print(
            "zoom_distance=",
            initial_zoom_distance,
            "->",
            detail_zoom_distance,
            "->",
            continued_zoom_distance,
        )
        print("messages=", messages)
        assert dimensions["sw"] == dimensions["cw"]
        assert dimensions["sh"] == dimensions["ch"]
        assert not [item for item in messages if item.startswith("pageerror:")]
        browser.close()


if __name__ == "__main__":
    run()
