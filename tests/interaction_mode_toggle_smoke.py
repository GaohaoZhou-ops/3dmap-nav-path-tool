import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
FIXTURE = Path(__file__).parent / "fixtures" / "rotation-map.ply"


def read_vector(canvas, prefix):
    return {
        axis: float(canvas.get_attribute(f"data-{prefix}-{axis}"))
        for axis in ("x", "y", "z")
    }


def run():
    page_errors = []
    console_errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.set_default_timeout(30_000)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )

        page.goto(f"{BASE_URL.rstrip('/')}/workbench", wait_until="networkidle")
        page.locator('input[type="file"][accept=".ply"]').set_input_files(str(FIXTURE))
        page.locator(".loading-curtain").wait_for(state="hidden")

        canvas = page.get_by_label("三维点云交互画布")
        mode_button = page.locator(".viewer-interaction-mode")
        assert mode_button.get_attribute("data-base-mode") == "rotate"
        assert mode_button.get_attribute("data-mode") == "rotate"
        assert mode_button.inner_text().strip() == "旋转"
        assert canvas.get_attribute("data-interaction-mode") == "rotate"
        rotate_background = mode_button.evaluate(
            "element => getComputedStyle(element).backgroundImage"
        )

        mode_button.click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.interactionMode === 'pan'"
        )
        assert mode_button.get_attribute("data-base-mode") == "pan"
        assert mode_button.get_attribute("data-mode") == "pan"
        assert mode_button.inner_text().strip() == "平移"
        assert "is-pan-mode" in (mode_button.get_attribute("class") or "")
        assert "lucide-move3d" in mode_button.locator("svg").get_attribute("class")
        assert canvas.get_attribute("data-effective-interaction-mode") == "pan"
        assert mode_button.evaluate(
            "element => getComputedStyle(element).backgroundImage"
        ) != rotate_background

        target_before = read_vector(canvas, "target")
        camera_before = read_vector(canvas, "camera")
        box = canvas.bounding_box()
        assert box
        page.mouse.move(
            box["x"] + box["width"] * 0.40,
            box["y"] + box["height"] * 0.47,
        )
        page.mouse.down()
        page.mouse.move(
            box["x"] + box["width"] * 0.60,
            box["y"] + box["height"] * 0.60,
            steps=4,
        )
        page.mouse.up()
        target_after = read_vector(canvas, "target")
        camera_after = read_vector(canvas, "camera")
        assert canvas.get_attribute("data-last-pointer-gesture") == "mode-pan"
        assert any(
            abs(target_after[axis] - target_before[axis]) > 1e-5
            for axis in ("x", "y", "z")
        )
        for axis in ("x", "y", "z"):
            assert abs(
                (camera_after[axis] - camera_before[axis])
                - (target_after[axis] - target_before[axis])
            ) < 1e-6

        canvas.focus()
        page.keyboard.down("Shift")
        page.wait_for_function(
            "document.querySelector('.viewer-interaction-mode')?.dataset.mode === 'shift-pan'"
        )
        assert mode_button.inner_text().strip() == "平移"
        page.keyboard.up("Shift")
        page.wait_for_function(
            "document.querySelector('.viewer-interaction-mode')?.dataset.mode === 'pan'"
        )
        page.screenshot(path="/tmp/atlas-persistent-pan-mode.png", full_page=True)

        mode_button.click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.interactionMode === 'rotate'"
        )
        assert mode_button.inner_text().strip() == "旋转"
        assert "lucide-rotate3d" in mode_button.locator("svg").get_attribute("class")

        canvas.focus()
        page.keyboard.down("Shift")
        page.wait_for_function(
            "document.querySelector('.viewer-interaction-mode')?.dataset.mode === 'shift-pan'"
        )
        assert mode_button.inner_text().strip() == "Shift 平移"
        assert "is-temporary" in (mode_button.get_attribute("class") or "")
        page.keyboard.up("Shift")
        page.wait_for_function(
            "document.querySelector('.viewer-interaction-mode')?.dataset.mode === 'rotate'"
        )
        assert mode_button.inner_text().strip() == "旋转"

        page.screenshot(path="/tmp/atlas-interaction-mode-toggle.png", full_page=True)
        print("persistent_pan_drag=passed")
        print("shift_override=passed")
        print("page_errors=", page_errors)
        print("console_errors=", console_errors)
        assert not page_errors
        assert not console_errors
        browser.close()


if __name__ == "__main__":
    run()
