import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
FIXTURE = Path(__file__).parent / "fixtures" / "rotation-map.ply"


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

        # Narrow the range around the isolated Z=0.8 point so the extreme-zoom
        # footprint assertion below measures one source point deterministically.
        page.get_by_role("slider", name="截面高度跨度").press("Home")
        height_input = page.get_by_label("截面中心高度数值")
        height_input.fill("0.80")
        height_input.press("Enter")
        page.wait_for_timeout(220)
        page.locator(".projection-status").wait_for(state="hidden")

        vector_canvas = page.get_by_label("二维矢量点云截面")
        assert vector_canvas.is_visible()
        assert vector_canvas.get_attribute("data-render-mode") == "vector-coordinate-webgl"
        assert vector_canvas.get_attribute("data-source-point-count") == "24"
        assert page.get_by_text("LIVE VECTOR", exact=True).is_visible()

        map_view = page.locator(".map2d-view")
        box = map_view.bounding_box()
        assert box
        target_x = 2.0
        target_y = 1.4

        def target_screen():
            scale = float(vector_canvas.get_attribute("data-view-scale"))
            center_x = float(vector_canvas.get_attribute("data-view-center-x"))
            center_y = float(vector_canvas.get_attribute("data-view-center-y"))
            return (
                box["x"] + (target_x - center_x) * scale + box["width"] / 2,
                box["y"] + (center_y - target_y) * scale + box["height"] / 2,
            )

        initial_scale = float(vector_canvas.get_attribute("data-view-scale"))
        for _ in range(8):
            cursor_x, cursor_y = target_screen()
            assert box["x"] <= cursor_x <= box["x"] + box["width"]
            assert box["y"] <= cursor_y <= box["y"] + box["height"]
            page.mouse.move(cursor_x, cursor_y)
            previous_scale = float(vector_canvas.get_attribute("data-view-scale"))
            page.mouse.wheel(0, -500)
            page.wait_for_function(
                "([canvas, previous]) => Number(canvas.dataset.viewScale) > previous",
                arg=[vector_canvas.element_handle(), previous_scale],
            )

        detail_scale = float(vector_canvas.get_attribute("data-view-scale"))
        assert detail_scale > initial_scale * 100
        assert float(vector_canvas.get_attribute("data-world-units-per-pixel")) < 0.0001
        assert int(page.locator(".map2d-readout").get_attribute("data-coordinate-precision")) >= 5

        # At extreme zoom an isolated source point must remain a small GPU point,
        # rather than expanding into a block from a pre-rendered bitmap texture.
        point_footprint = vector_canvas.evaluate(
            """
            (canvas, target) => {
              const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
              const scale = Number(canvas.dataset.viewScale);
              const centerX = Number(canvas.dataset.viewCenterX);
              const centerY = Number(canvas.dataset.viewCenterY);
              const cssWidth = canvas.getBoundingClientRect().width;
              const cssHeight = canvas.getBoundingClientRect().height;
              const screenX = (target.x - centerX) * scale + cssWidth / 2;
              const screenY = (centerY - target.y) * scale + cssHeight / 2;
              const pixelX = Math.round(screenX * canvas.width / cssWidth);
              const pixelY = Math.round((cssHeight - screenY) * canvas.height / cssHeight);
              const radius = 12;
              if (pixelX < 0 || pixelX >= canvas.width || pixelY < 0 || pixelY >= canvas.height) {
                return { count: 0, width: 0, height: 0, pixelX, pixelY };
              }
              const startX = Math.max(0, Math.min(canvas.width - 1, pixelX - radius));
              const startY = Math.max(0, Math.min(canvas.height - 1, pixelY - radius));
              const width = Math.min(canvas.width - startX, radius * 2 + 1);
              const height = Math.min(canvas.height - startY, radius * 2 + 1);
              const pixels = new Uint8Array(width * height * 4);
              gl.finish();
              gl.readPixels(startX, startY, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
              let minX = width;
              let minY = height;
              let maxX = -1;
              let maxY = -1;
              let count = 0;
              for (let y = 0; y < height; y += 1) {
                for (let x = 0; x < width; x += 1) {
                  if (pixels[(y * width + x) * 4 + 3] < 8) continue;
                  count += 1;
                  minX = Math.min(minX, x);
                  minY = Math.min(minY, y);
                  maxX = Math.max(maxX, x);
                  maxY = Math.max(maxY, y);
                }
              }
              return {
                count,
                width: maxX >= minX ? maxX - minX + 1 : 0,
                height: maxY >= minY ? maxY - minY + 1 : 0,
              };
            }
            """,
            {"x": target_x, "y": target_y},
        )
        print("scale=", initial_scale, "->", detail_scale)
        print("point_footprint=", point_footprint)
        assert point_footprint["count"] > 0
        assert point_footprint["width"] <= 8
        assert point_footprint["height"] <= 8

        page.get_by_role("button", name="添加导航点").click()
        cursor_x, cursor_y = target_screen()
        page.mouse.click(cursor_x, cursor_y)
        waypoint = page.locator(".waypoint-marker")
        assert waypoint.count() == 1
        assert "Z 0.80" in waypoint.get_attribute("title")

        page.wait_for_timeout(3300)
        page.screenshot(path="/tmp/atlas-vector-map-detail.png", full_page=True)
        assert not errors
        assert not console_errors
        browser.close()


if __name__ == "__main__":
    run()
