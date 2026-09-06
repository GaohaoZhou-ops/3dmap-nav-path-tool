import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
FIXTURE = Path(__file__).parent / "fixtures" / "rotation-map.ply"


def wait_for_session(page):
    page.locator('[data-session-state="ready"]').wait_for(timeout=30_000)
    page.locator(".loading-curtain").wait_for(state="hidden", timeout=30_000)


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
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.set_default_timeout(30_000)
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        page.goto(BASE_URL)
        page.wait_for_load_state("networkidle")
        wait_for_session(page)
        session_identity = page.evaluate(
            "fetch('/__atlas/session', {cache:'no-store'}).then(response => response.json())"
        )

        page.locator('input[type="file"][accept=".ply"]').set_input_files(str(FIXTURE))
        page.locator(".map-state-dot.online").wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.locator(".projection-status").wait_for(state="hidden")

        color_toggle = page.get_by_role("button", name="按高度渲染点云")
        color_toggle.click()
        assert color_toggle.get_attribute("aria-pressed") == "true"
        assert page.locator(".three-canvas").get_attribute("data-color-mode") == "height"
        assert page.get_by_label("点云高程比例尺").is_visible()
        assert page.get_by_label("二维矢量点云截面").get_attribute("data-source-point-count") == "24"

        height_input = page.locator(".height-range__inputs input")
        requested_height = float(height_input.input_value()) + 0.25
        height_input.fill(f"{requested_height:.2f}")
        height_input.press("Enter")
        restored_height = float(height_input.input_value())
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
        limit_inputs = page.locator(".property-editor .numeric-field input")
        limit_inputs.nth(1).fill("2.75")
        limit_inputs.nth(1).press("Enter")

        page.mouse.move(center_x, center_y)
        page.mouse.wheel(0, -240)
        page.wait_for_timeout(700)
        view_before_refresh = page.locator(".map2d-scale-readout").inner_text()

        records = read_workspace_records(page)
        record_by_key = {record["key"]: record for record in records}
        assert set(record_by_key) == {"meta", "map", "config"}
        assert record_by_key["meta"]["sessionId"] == session_identity["sessionId"]
        assert record_by_key["map"]["name"] == FIXTURE.name
        assert record_by_key["map"]["byteLength"] == FIXTURE.stat().st_size
        assert record_by_key["map"]["mapId"] == record_by_key["config"]["mapId"]

        page.reload()
        page.wait_for_load_state("networkidle")
        wait_for_session(page)
        session_guard = page.locator(".session-guard")
        assert session_guard.get_attribute("data-session-restored") == "true"
        assert page.locator(".map-identity strong").inner_text() == FIXTURE.name
        assert page.locator(".three-canvas").get_attribute("data-render-point-count") == "24"
        assert page.locator(".three-canvas").get_attribute("data-color-mode") == "height"
        assert page.get_by_role("button", name="按高度渲染点云").get_attribute("aria-pressed") == "true"
        assert page.get_by_label("点云高程比例尺").is_visible()
        assert page.get_by_label("二维矢量点云截面").get_attribute("data-render-mode") == "vector-coordinate-webgl"
        assert page.locator(".waypoint-marker").count() == 2
        assert page.locator(".route-edge").count() == 1
        assert page.get_by_role("heading", name="路径参数").is_visible()
        assert page.locator(".property-editor .numeric-field input").nth(1).input_value() == "2.75"
        actual_restored_height = float(
            page.get_by_role("slider", name="截面中心高度").get_attribute("aria-valuenow")
        )
        print("restored_height=", restored_height, "actual=", actual_restored_height)
        assert abs(actual_restored_height - restored_height) < 0.01
        assert page.locator(".map2d-scale-readout").inner_text() == view_before_refresh
        page.screenshot(path="/tmp/atlas-session-restored.png", full_page=True)

        simulate_service_restart(page)
        page.reload()
        page.wait_for_load_state("networkidle")
        wait_for_session(page)
        assert page.locator(".session-guard").get_attribute("data-session-restored") == "false"
        assert page.locator(".map-identity strong").inner_text() == "NO MAP LOADED"
        assert page.locator(".three-canvas").count() == 0
        assert page.locator(".waypoint-marker").count() == 0
        remaining_records = read_workspace_records(page)
        remaining_by_key = {record["key"]: record for record in remaining_records}
        assert "map" not in remaining_by_key
        assert set(remaining_by_key).issubset({"meta", "config"})
        assert remaining_by_key["meta"]["sessionId"] == session_identity["sessionId"]

        print("session_id=", session_identity["sessionId"])
        print("restored_map=", FIXTURE.name)
        print("restored_waypoints=", 2)
        print("restored_edges=", 1)
        print("page_errors=", errors)
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
