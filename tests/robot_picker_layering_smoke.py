import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
FIXTURE = Path(__file__).parent / "fixtures" / "rotation-map.ply"
CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")


def menu_snapshot(page, label):
    trigger = page.get_by_role("button", name="加载机器人")
    trigger.click()
    menu = page.locator(".robot-picker__menu")
    menu.wait_for()
    page.wait_for_timeout(200)

    report = menu.evaluate(
        """
        (menu) => {
          const rect = menu.getBoundingClientRect();
          const points = [
            [rect.left + 2, rect.top + 2],
            [rect.left + rect.width / 2, rect.top + 2],
            [rect.left + rect.width / 2, rect.top + rect.height / 2],
            [rect.right - 2, rect.bottom - 2],
          ];
          return {
            menuRect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
            viewport: {width: innerWidth, height: innerHeight},
            parentTag: menu.parentElement?.tagName || '',
            position: getComputedStyle(menu).position,
            zIndex: Number(getComputedStyle(menu).zIndex),
            overflowAncestors: Array.from((function* () {
              let node = menu.parentElement;
              while (node) {
                const style = getComputedStyle(node);
                if (style.overflow !== 'visible'
                    || style.overflowX !== 'visible'
                    || style.overflowY !== 'visible') {
                  yield {
                    tag: node.tagName,
                    className: node.className,
                    overflow: style.overflow,
                    overflowX: style.overflowX,
                    overflowY: style.overflowY,
                  };
                }
                node = node.parentElement;
              }
            })()),
            topElements: points.map(([x, y]) => ({
              x,
              y,
              className: document.elementFromPoint(x, y)?.className || '',
              insideMenu: menu.contains(document.elementFromPoint(x, y)),
            })),
          };
        }
        """
    )
    page.screenshot(path=f"/tmp/atlas-robot-picker-{label}.png", full_page=True)
    return report


def assert_menu_is_unobscured(report):
    assert report["parentTag"] == "BODY"
    assert report["position"] == "fixed"
    assert report["zIndex"] > 100
    assert report["menuRect"]["y"] >= 0
    assert report["menuRect"]["y"] + report["menuRect"]["height"] <= report["viewport"]["height"]
    assert all(point["insideMenu"] for point in report["topElements"])
    assert not any(
        ancestor["className"] == "topbar-actions"
        for ancestor in report["overflowAncestors"]
    )


def run():
    errors = []
    with sync_playwright() as playwright:
        options = {"headless": True}
        if CHROME.exists():
            options["executable_path"] = str(CHROME)
        browser = playwright.chromium.launch(**options)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(30_000)
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        page.goto(f"{BASE_URL.rstrip('/')}/workbench")
        page.wait_for_load_state("networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        map_report = menu_snapshot(page, "map")
        assert_menu_is_unobscured(map_report)

        page.get_by_role("button", name="加载机器人").click()
        page.locator('[data-independent-teaching-input="true"]').set_input_files(str(FIXTURE))
        page.locator('.app-shell[data-teaching-space-mode="independent"]').wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        independent_report = menu_snapshot(page, "independent")
        assert_menu_is_unobscured(independent_report)
        page.get_by_role("option", name="加载机器人 botx_abx_zivid_m70").click()
        page.locator(".robot-picker__menu").wait_for(state="detached")
        assert page.locator(".robot-picker").get_attribute("data-selected-robot")

        print("map_report=", map_report)
        print("independent_report=", independent_report)
        print("page_errors=", errors)
        browser.close()


if __name__ == "__main__":
    run()
