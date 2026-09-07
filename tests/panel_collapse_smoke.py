import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
FIXTURE = Path(__file__).parent / "fixtures" / "rotation-map.ply"


def element_height(locator):
    return locator.evaluate("element => element.getBoundingClientRect().height")


def wait_for_session(page):
    page.locator('[data-session-state="ready"]').wait_for(timeout=30_000)
    page.locator(".loading-curtain").wait_for(state="hidden", timeout=30_000)


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
        page.locator('input[type="file"][accept=".ply"]').set_input_files(str(FIXTURE))
        page.locator(".map-state-dot.online").wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.locator(".projection-status").wait_for(state="hidden")

        workspace = page.locator(".visual-workspace")
        panel_3d = page.locator(".panel-3d")
        panel_2d = page.locator(".panel-2d")
        body_3d = page.locator("#panel-body-3d")
        body_2d = page.locator("#panel-body-2d")
        initial_3d_height = element_height(body_3d)
        initial_2d_height = element_height(body_2d)
        assert initial_3d_height > 200
        assert initial_2d_height > 200
        assert workspace.get_attribute("data-collapsed-panel") == "none"

        collapse_3d = page.get_by_role("button", name="折叠3D窗口")
        assert collapse_3d.get_attribute("aria-expanded") == "true"
        collapse_3d.click()
        page.wait_for_timeout(320)
        assert workspace.get_attribute("data-collapsed-panel") == "3d"
        assert panel_3d.get_attribute("data-collapsed") == "true"
        assert panel_2d.get_attribute("data-collapsed") == "false"
        assert element_height(body_3d) < 1
        expanded_2d_height = element_height(body_2d)
        assert expanded_2d_height > initial_2d_height * 1.6
        assert page.locator(".map2d-vector-canvas").count() == 1
        page.screenshot(path="/tmp/atlas-2d-expanded.png", full_page=True)

        expand_3d = page.get_by_role("button", name="展开3D窗口")
        assert expand_3d.get_attribute("aria-expanded") == "false"
        expand_3d.click()
        page.wait_for_timeout(320)
        assert workspace.get_attribute("data-collapsed-panel") == "none"
        assert abs(element_height(body_3d) - initial_3d_height) < 3
        assert abs(element_height(body_2d) - initial_2d_height) < 3

        page.get_by_role("button", name="折叠2D窗口").click()
        page.wait_for_timeout(320)
        assert workspace.get_attribute("data-collapsed-panel") == "2d"
        assert panel_2d.get_attribute("data-collapsed") == "true"
        assert element_height(body_2d) < 1
        expanded_3d_height = element_height(body_3d)
        assert expanded_3d_height > initial_3d_height * 1.6
        assert page.locator(".three-canvas").count() == 1
        page.screenshot(path="/tmp/atlas-3d-expanded.png", full_page=True)

        # Folding the other panel switches the target instead of hiding both maps.
        page.get_by_role("button", name="折叠3D窗口").click()
        page.wait_for_timeout(320)
        assert workspace.get_attribute("data-collapsed-panel") == "3d"
        assert panel_3d.get_attribute("data-collapsed") == "true"
        assert panel_2d.get_attribute("data-collapsed") == "false"
        page.get_by_role("button", name="展开3D窗口").click()
        page.wait_for_timeout(320)

        # The collapsed panel is part of the protected UI session.
        page.get_by_role("button", name="折叠2D窗口").click()
        page.wait_for_timeout(600)
        page.reload(wait_until="domcontentloaded")
        wait_for_session(page)
        assert workspace.get_attribute("data-collapsed-panel") == "2d"
        assert page.locator(".panel-2d").get_attribute("data-collapsed") == "true"
        assert element_height(page.locator("#panel-body-2d")) < 1
        assert element_height(page.locator("#panel-body-3d")) > initial_3d_height * 1.6
        assert page.locator(".three-canvas").get_attribute("data-geometry-source") == "session-cache"
        page.get_by_role("button", name="展开2D窗口").click()
        page.wait_for_timeout(320)
        assert workspace.get_attribute("data-collapsed-panel") == "none"

        print("initial_heights=", initial_3d_height, initial_2d_height)
        print("expanded_heights=", expanded_3d_height, expanded_2d_height)
        print("page_errors=", errors)
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
