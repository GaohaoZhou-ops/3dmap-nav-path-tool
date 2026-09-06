import os

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
EXPECTED_POINTS = "2685018"
EXPECTED_BYTES = 51_015_691


def wait_for_session(page):
    page.locator('[data-session-state="ready"]').wait_for(timeout=120_000)
    page.locator(".loading-curtain").wait_for(state="hidden", timeout=120_000)


def stored_map_size(page):
    return page.evaluate(
        """
        async () => {
          const database = await new Promise((resolve, reject) => {
            const request = indexedDB.open('atlas-route-studio', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const transaction = database.transaction('workspace-session', 'readonly');
          const record = await new Promise((resolve, reject) => {
            const request = transaction.objectStore('workspace-session').get('map');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          database.close();
          return record?.byteLength || 0;
        }
        """
    )


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.set_default_timeout(120_000)

        page.goto(BASE_URL)
        page.wait_for_load_state("networkidle")
        wait_for_session(page)
        page.get_by_role("button", name="示例地图").click()
        page.locator(".map-state-dot.online").wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.locator(".projection-status").wait_for(state="hidden")
        assert stored_map_size(page) == EXPECTED_BYTES

        page.reload(wait_until="domcontentloaded")
        wait_for_session(page)
        assert page.locator(".session-guard").get_attribute("data-session-restored") == "true"
        assert page.locator(".map-identity strong").inner_text() == "xian_map.ply"
        assert page.locator(".three-canvas").get_attribute("data-render-point-count") == EXPECTED_POINTS
        assert page.get_by_label("二维矢量点云截面").get_attribute("data-source-point-count") == EXPECTED_POINTS
        page.locator(".projection-status").wait_for(state="hidden")
        page.screenshot(path="/tmp/atlas-example-session-restored.png", full_page=True)

        print("stored_map_bytes=", stored_map_size(page))
        print("restored_points=", EXPECTED_POINTS)
        print("page_errors=", errors)
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
