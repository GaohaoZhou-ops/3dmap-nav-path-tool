import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
FIXTURE = Path(__file__).parent / "fixtures" / "rotation-map.ply"


def wait_for_session(page):
    page.locator('[data-session-state="ready"]').wait_for(timeout=30_000)
    page.locator(".loading-curtain").wait_for(state="hidden", timeout=30_000)


def click_path_midpoint(page, path):
    point = path.evaluate(
        """
        (element) => {
          const local = element.getPointAtLength(element.getTotalLength() / 2);
          const screen = new DOMPoint(local.x, local.y).matrixTransform(element.getScreenCTM());
          return {x: screen.x, y: screen.y};
        }
        """
    )
    page.mouse.click(point["x"], point["y"])


def read_workspace_records(page):
    return page.evaluate(
        """
        async () => {
          const database = await new Promise((resolve, reject) => {
            const request = indexedDB.open('atlas-route-studio', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const transaction = database.transaction('workspace-session', 'readonly');
          const records = await new Promise((resolve, reject) => {
            const request = transaction.objectStore('workspace-session').getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          database.close();
          return records.map((record) => ({
            key: record.key,
            sessionId: record.sessionId,
            mapId: record.mapId || null,
            name: record.name || null,
            byteLength: record.byteLength || 0,
            geometryCacheVersion: record.geometryCacheVersion || 0,
            hasBlob: record.blob instanceof Blob,
            positionByteLength: record.positionBuffer?.byteLength || 0,
            colorByteLength: record.colorBuffer?.byteLength || 0,
            recoveryId: record.recoveryId || null,
            available: record.available === true,
            mapName: record.mapName || null,
            taskCount: record.taskCount || 0,
          }));
        }
        """
    )


def simulate_service_restart(page):
    page.evaluate(
        """
        async () => {
          const database = await new Promise((resolve, reject) => {
            const request = indexedDB.open('atlas-route-studio', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const transaction = database.transaction('workspace-session', 'readwrite');
          transaction.objectStore('workspace-session').put({
            key: 'meta',
            sessionId: 'simulated-previous-service',
            startedAt: 0,
          });
          await new Promise((resolve, reject) => {
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
          });
          database.close();
        }
        """
    )


def run():
    errors = []
    with sync_playwright() as playwright:
        launch_options = {"headless": True}
        system_chrome = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        if system_chrome.exists():
            launch_options["executable_path"] = str(system_chrome)
        browser = playwright.chromium.launch(**launch_options)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.set_default_timeout(30_000)
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        page.goto(f"{BASE_URL.rstrip('/')}/workbench")
        page.wait_for_load_state("networkidle")
        wait_for_session(page)
        session_identity = page.evaluate(
            "fetch('/__atlas/session', {cache:'no-store'}).then(response => response.json())"
        )

        page.locator('input[type="file"][accept=".ply"]').set_input_files(str(FIXTURE))
        page.locator(".map-state-dot.online").wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.locator(".projection-status").wait_for(state="hidden")

        color_toggle = page.get_by_role("button", name="切换点云颜色模式")
        assert color_toggle.get_attribute("data-color-mode") == "height"
        color_toggle.click()
        color_toggle.click()
        assert color_toggle.get_attribute("data-color-mode") == "white"
        assert page.locator(".three-canvas").get_attribute("data-color-mode") == "white"
        assert page.get_by_label("二维矢量点云截面").get_attribute("data-color-mode") == "white"
        assert page.get_by_label("点云高程比例尺").count() == 0
        assert page.get_by_label("二维矢量点云截面").get_attribute("data-source-point-count") == "24"

        height_input = page.get_by_label("截面中心高度数值")
        requested_height = float(height_input.input_value()) + 0.25
        height_input.fill(f"{requested_height:.2f}")
        height_input.press("Enter")
        span_input = page.get_by_role("slider", name="截面高度跨度")
        requested_span = max(
            float(span_input.get_attribute("min")),
            float(span_input.input_value()) * 0.7,
        )
        span_input.evaluate(
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
            requested_span,
        )
        restored_span = float(span_input.input_value())
        center_slider = page.get_by_role("slider", name="截面中心高度")
        center_slider.press("Home")
        restored_height = float(center_slider.get_attribute("aria-valuenow"))
        restored_slice_min = float(center_slider.get_attribute("data-slice-min"))
        cloud_min = float(page.locator(".height-range").get_attribute("data-cloud-min"))
        assert restored_slice_min < cloud_min
        page.locator(".projection-status").wait_for(state="hidden")

        page.get_by_role("button", name="添加导航点").click()
        map_box = page.locator(".map2d-view").bounding_box()
        assert map_box
        center_x = map_box["x"] + map_box["width"] / 2
        center_y = map_box["y"] + map_box["height"] / 2
        page.mouse.click(center_x - 55, center_y)
        page.mouse.click(center_x + 55, center_y)
        assert page.locator(".waypoint-marker").count() == 2

        page.get_by_role("button", name="连接路径").click()
        page.locator(".waypoint-marker").nth(0).click()
        page.locator(".waypoint-marker").nth(1).click()
        assert page.locator(".route-edge").count() == 1
        three_canvas = page.locator(".three-canvas")
        assert three_canvas.get_attribute("data-rendered-waypoint-count") == "2"
        assert three_canvas.get_attribute("data-route-edge-count") == "1"
        assert three_canvas.get_attribute("data-waypoint-volume-ratio") == "0.14"
        assert abs(float(three_canvas.get_attribute("data-waypoint-radius-scale")) - 0.519249) < 1e-6
        assert abs(float(three_canvas.get_attribute("data-waypoint-hit-radius-scale")) - 1.286568) < 1e-6
        visible_waypoint_frame = three_canvas.screenshot()
        hide_waypoints = page.get_by_role("button", name="隐藏3D路径点")
        assert hide_waypoints.get_attribute("aria-pressed") == "true"
        hide_waypoints.click()
        page.wait_for_timeout(120)
        assert three_canvas.get_attribute("data-waypoints-visible") == "false"
        assert page.get_by_role("button", name="显示3D路径点").get_attribute("aria-pressed") == "false"
        assert three_canvas.get_attribute("data-route-edge-count") == "1"
        hidden_waypoint_frame = three_canvas.screenshot()
        assert hidden_waypoint_frame != visible_waypoint_frame
        page.get_by_role("button", name="倒车", exact=True).click()
        perception_switch = page.get_by_role("switch", name="3D感知避障")
        perception_switch.click()
        assert perception_switch.get_attribute("aria-checked") == "false"
        limit_inputs = page.locator(".property-editor .numeric-field input")
        limit_inputs.nth(1).fill("2.75")
        limit_inputs.nth(1).press("Enter")

        # Move both independent viewports before refreshing. The session must
        # retain the 2D world center/scale and the complete 3D camera pose.
        page.get_by_role("button", name="选择 / 漫游").click()
        page.mouse.move(center_x - 80, center_y - 35)
        page.mouse.down()
        page.mouse.move(center_x + 35, center_y + 30, steps=4)
        page.mouse.up()
        page.mouse.move(center_x, center_y)
        page.mouse.wheel(0, -240)

        three_box = three_canvas.bounding_box()
        assert three_box
        assert page.get_by_role("button", name="旋转", exact=True).get_attribute(
            "data-base-mode"
        ) == "rotate"
        three_canvas.focus()
        page.mouse.move(
            three_box["x"] + three_box["width"] * 0.38,
            three_box["y"] + three_box["height"] * 0.62,
        )
        page.mouse.down()
        page.mouse.move(
            three_box["x"] + three_box["width"] * 0.59,
            three_box["y"] + three_box["height"] * 0.36,
            steps=5,
        )
        page.mouse.up()
        page.mouse.move(
            three_box["x"] + three_box["width"] * 0.52,
            three_box["y"] + three_box["height"] * 0.5,
        )
        page.mouse.wheel(0, -620)
        three_canvas.focus()
        page.keyboard.press("ArrowLeft")
        page.wait_for_timeout(700)
        view2d_before_refresh = {
            key: float(page.locator(".map2d-view").get_attribute(f"data-view-{key}"))
            for key in ("center-x", "center-y", "scale")
        }
        view3d_before_refresh = {
            key: float(three_canvas.get_attribute(f"data-{key}"))
            for key in (
                "camera-x",
                "camera-y",
                "camera-z",
                "target-x",
                "target-y",
                "target-z",
                "camera-up-x",
                "camera-up-y",
                "camera-up-z",
                "optical-zoom",
                "precision-pan-x",
                "precision-pan-y",
            )
        }
        assert "重置视角" in page.get_by_role("button", name="重置3D视角").inner_text()
        assert "重置视角" in page.get_by_role("button", name="重置2D视角").inner_text()
        assert page.get_by_role("button", name="重置全部视角").count() == 0

        records = read_workspace_records(page)
        record_by_key = {record["key"]: record for record in records}
        assert set(record_by_key) == {
            "meta",
            "workspace-slots",
            "workspace-map:map",
            "workspace-config:map",
        }
        map_record = record_by_key["workspace-map:map"]
        config_record = record_by_key["workspace-config:map"]
        assert record_by_key["meta"]["sessionId"] == session_identity["sessionId"]
        assert map_record["name"] == FIXTURE.name
        assert map_record["byteLength"] == FIXTURE.stat().st_size
        assert map_record["geometryCacheVersion"] == 1
        assert not map_record["hasBlob"]
        assert map_record["positionByteLength"] == 24 * 3 * 4
        assert map_record["colorByteLength"] == 24 * 3
        assert map_record["mapId"] == config_record["mapId"]

        page.reload()
        page.wait_for_load_state("networkidle")
        wait_for_session(page)
        session_guard = page.locator(".session-guard")
        assert session_guard.get_attribute("data-session-restored") == "true"
        assert page.locator(".map-identity strong").inner_text() == FIXTURE.name
        assert page.locator(".three-canvas").get_attribute("data-render-point-count") == "24"
        assert page.locator(".three-canvas").get_attribute("data-geometry-source") == "session-cache"
        assert page.locator(".three-canvas").get_attribute("data-color-mode") == "white"
        assert page.locator(".three-canvas").get_attribute("data-waypoints-visible") == "false"
        assert page.get_by_role("button", name="显示3D路径点").get_attribute("aria-pressed") == "false"
        page.get_by_role("button", name="显示3D路径点").click()
        assert page.locator(".three-canvas").get_attribute("data-waypoints-visible") == "true"
        assert page.get_by_role("button", name="切换点云颜色模式").get_attribute("data-color-mode") == "white"
        assert page.get_by_label("二维矢量点云截面").get_attribute("data-color-mode") == "white"
        assert page.get_by_label("点云高程比例尺").count() == 0
        assert page.get_by_label("二维矢量点云截面").get_attribute("data-render-mode") == "vector-coordinate-webgl"
        assert page.locator(".waypoint-marker").count() == 2
        assert page.locator(".route-edge").count() == 1
        assert page.get_by_role("heading", name="路径参数").is_visible()
        assert page.get_by_role("button", name="倒车", exact=True).get_attribute("aria-pressed") == "true"
        assert page.get_by_role("switch", name="3D感知避障").get_attribute("aria-checked") == "false"
        assert page.get_by_label("路径距离").is_visible()
        assert page.locator(".property-editor .numeric-field input").nth(1).input_value() == "2.75"
        page.get_by_role("button", name="选择 / 漫游").click()
        page.locator(".waypoint-marker").first.click()
        assert page.locator(".route-edge.is-selected").count() == 0
        route_button = page.get_by_role("button", name="配置路径 P01 到 P02")
        click_path_midpoint(page, route_button)
        assert page.locator(".route-edge.is-selected").count() == 1
        assert page.get_by_role("heading", name="路径参数").is_visible()
        actual_restored_height = float(
            page.get_by_role("slider", name="截面中心高度").get_attribute("aria-valuenow")
        )
        print("restored_height=", restored_height, "actual=", actual_restored_height)
        assert abs(actual_restored_height - restored_height) < 0.01
        actual_restored_span = float(
            page.get_by_role("slider", name="截面高度跨度").input_value()
        )
        print("restored_span=", restored_span, "actual=", actual_restored_span)
        assert abs(actual_restored_span - restored_span) < 0.01
        actual_restored_slice_min = float(
            page.get_by_role("slider", name="截面中心高度").get_attribute("data-slice-min")
        )
        assert abs(actual_restored_slice_min - restored_slice_min) < 0.01
        restored_view2d = {
            key: float(page.locator(".map2d-view").get_attribute(f"data-view-{key}"))
            for key in ("center-x", "center-y", "scale")
        }
        restored_canvas = page.locator(".three-canvas")
        restored_view3d = {
            key: float(restored_canvas.get_attribute(f"data-{key}"))
            for key in view3d_before_refresh
        }
        for key, expected in view2d_before_refresh.items():
            assert abs(restored_view2d[key] - expected) <= max(1e-7, abs(expected) * 1e-8)
        for key, expected in view3d_before_refresh.items():
            assert abs(restored_view3d[key] - expected) <= max(1e-7, abs(expected) * 1e-8)
        assert restored_canvas.get_attribute("data-view-restored") == "true"
        page.screenshot(path="/tmp/atlas-session-restored.png", full_page=True)

        # The synchronous lightweight view snapshot closes the debounce gap:
        # change both views and refresh immediately, without waiting for the
        # IndexedDB workspace timer.
        map_view = page.locator(".map2d-view")
        scale_before_immediate_change = float(map_view.get_attribute("data-view-scale"))
        page.locator(".map-zoom-controls").get_by_role("button", name="放大").click()
        page.wait_for_function(
            "([selector, previous]) => Number(document.querySelector(selector)?.dataset.viewScale) > previous",
            arg=[".map2d-view", scale_before_immediate_change],
        )
        restored_box = restored_canvas.bounding_box()
        assert restored_box
        page.mouse.move(
            restored_box["x"] + restored_box["width"] * 0.51,
            restored_box["y"] + restored_box["height"] * 0.49,
        )
        camera_distance_before = float(
            restored_canvas.get_attribute("data-effective-camera-distance")
        )
        page.mouse.wheel(0, -700)
        page.wait_for_function(
            "([selector, previous]) => Number(document.querySelector(selector)?.dataset.effectiveCameraDistance) !== previous",
            arg=[".three-canvas", camera_distance_before],
        )
        immediate_view2d = {
            key: float(map_view.get_attribute(f"data-view-{key}"))
            for key in ("center-x", "center-y", "scale")
        }
        immediate_view3d = {
            key: float(restored_canvas.get_attribute(f"data-{key}"))
            for key in view3d_before_refresh
        }
        page.reload()
        page.wait_for_load_state("networkidle")
        wait_for_session(page)
        immediate_restored_view2d = {
            key: float(page.locator(".map2d-view").get_attribute(f"data-view-{key}"))
            for key in immediate_view2d
        }
        immediate_restored_canvas = page.locator(".three-canvas")
        immediate_restored_view3d = {
            key: float(immediate_restored_canvas.get_attribute(f"data-{key}"))
            for key in immediate_view3d
        }
        for key, expected in immediate_view2d.items():
            assert abs(immediate_restored_view2d[key] - expected) <= max(1e-7, abs(expected) * 1e-8)
        for key, expected in immediate_view3d.items():
            assert abs(immediate_restored_view3d[key] - expected) <= max(1e-7, abs(expected) * 1e-8)

        page.get_by_role("button", name="重置3D视角").click()
        page.get_by_role("button", name="重置2D视角").click()
        page.wait_for_timeout(120)
        assert immediate_restored_canvas.get_attribute("data-view-state") == "reset"
        assert immediate_restored_canvas.get_attribute("data-view-reset-count") == "1"
        assert float(immediate_restored_canvas.get_attribute("data-optical-zoom")) == 1
        assert float(immediate_restored_canvas.get_attribute("data-precision-pan-x")) == 0
        assert float(immediate_restored_canvas.get_attribute("data-precision-pan-y")) == 0
        assert page.locator(".map2d-view").get_attribute("data-view-state") == "reset"
        assert page.locator(".map2d-view").get_attribute("data-view-reset-count") == "1"
        assert abs(
            float(page.locator(".map2d-view").get_attribute("data-view-scale"))
            - immediate_view2d["scale"]
        ) > 0.01
        recovery_view2d = {
            key: float(page.locator(".map2d-view").get_attribute(f"data-view-{key}"))
            for key in ("center-x", "center-y", "scale")
        }
        recovery_view3d = {
            key: float(immediate_restored_canvas.get_attribute(f"data-{key}"))
            for key in immediate_view3d
        }
        page.screenshot(path="/tmp/atlas-view-reset.png", full_page=True)

        simulate_service_restart(page)
        page.reload()
        page.wait_for_load_state("networkidle")
        wait_for_session(page)
        assert page.locator(".session-guard").get_attribute("data-session-restored") == "false"
        assert page.locator(".map-identity strong").inner_text() == "NO MAP LOADED"
        assert page.locator(".three-canvas").count() == 0
        assert page.locator(".waypoint-marker").count() == 0
        assert page.evaluate("localStorage.getItem('atlas-route-studio:view-state-v1')") is None
        load_project_button = page.get_by_role("button", name="加载工程")
        assert load_project_button.is_enabled()
        assert load_project_button.get_attribute("data-project-directory-picker") == "true"
        assert page.locator(".session-guard").get_attribute(
            "data-recovery-available"
        ) == "true"
        page.screenshot(path="/tmp/atlas-project-recovery.png", full_page=True)
        page.get_by_role("button", name="打开示教数据管理页").click()
        page.locator('[data-app-page="teaching-data"]').wait_for()
        recovery_button = page.get_by_role("button", name="恢复上一次工程")
        assert recovery_button.is_visible()
        remaining_records = read_workspace_records(page)
        remaining_by_key = {record["key"]: record for record in remaining_records}
        assert "workspace-map:map" not in remaining_by_key
        assert {"recovery-meta", "recovery-map", "recovery-config"}.issubset(
            remaining_by_key
        )
        assert remaining_by_key["recovery-meta"]["available"]
        assert remaining_by_key["recovery-meta"]["mapName"] == FIXTURE.name
        assert remaining_by_key["recovery-map"]["positionByteLength"] == 24 * 3 * 4
        assert remaining_by_key["recovery-map"]["recoveryId"] == remaining_by_key[
            "recovery-meta"
        ]["recoveryId"]
        assert remaining_by_key["meta"]["sessionId"] == session_identity["sessionId"]

        recovery_button.click()
        page.locator(".loading-curtain").wait_for(state="visible")
        page.wait_for_function(
            "document.querySelector('.session-guard')?.dataset.sessionRestored === 'true'"
        )
        page.wait_for_load_state("networkidle")
        wait_for_session(page)
        assert page.locator(".session-guard").get_attribute("data-session-restored") == "true"
        assert page.locator(".session-guard").get_attribute(
            "data-recovery-available"
        ) == "false"
        assert page.locator(".map-identity strong").inner_text() == FIXTURE.name
        assert page.locator(".three-canvas").get_attribute("data-geometry-source") == "session-cache"
        assert page.locator(".waypoint-marker").count() == 2
        assert page.locator(".route-edge").count() == 1
        assert page.get_by_role("button", name="加载工程").is_enabled()
        recovered_map_view = page.locator(".map2d-view")
        recovered_canvas = page.locator(".three-canvas")
        for key, expected in recovery_view2d.items():
            actual = float(recovered_map_view.get_attribute(f"data-view-{key}"))
            assert abs(actual - expected) <= max(1e-7, abs(expected) * 1e-8)
        for key, expected in recovery_view3d.items():
            actual = float(recovered_canvas.get_attribute(f"data-{key}"))
            assert abs(actual - expected) <= max(1e-7, abs(expected) * 1e-8)
        restored_records = read_workspace_records(page)
        restored_by_key = {record["key"]: record for record in restored_records}
        assert set(restored_by_key) == {
            "meta",
            "workspace-slots",
            "workspace-map:map",
            "workspace-config:map",
        }
        assert restored_by_key["workspace-map:map"]["positionByteLength"] == 24 * 3 * 4
        assert restored_by_key["workspace-map:map"]["mapId"] == restored_by_key[
            "workspace-config:map"
        ]["mapId"]

        print("session_id=", session_identity["sessionId"])
        print("restored_map=", FIXTURE.name)
        print("restored_waypoints=", 2)
        print("restored_edges=", 1)
        print("crash_recovery=", "passed")
        print("page_errors=", errors)
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
