import os
import hashlib
import json
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
ROOT = Path(__file__).resolve().parents[1]


def canvas_snapshot(canvas):
    keys = [
        "data-map-render-mode",
        "data-map-point-cloud-visible",
        "data-map-surface-visible",
        "data-map-surface-implementation",
        "data-map-surface-primitive",
        "data-map-surface-status",
        "data-map-surface-cache-hit",
        "data-map-surface-cell-count",
        "data-map-surface-triangle-count",
        "data-map-surface-voxel-size",
        "data-map-source-hash",
        "data-map-render-isolation",
        "data-robot-layer-visible",
        "data-robot-layer-render-isolation",
        "data-robot-model-state",
        "data-robot-model-name",
        "data-robot-link-count",
        "data-robot-joint-count",
        "data-robot-visual-count",
        "data-robot-zivid-count",
    ]
    return {key: canvas.get_attribute(key) for key in keys}


def run():
    errors = []
    console_errors = []
    use_example_map = os.environ.get("MAP_SOURCE") == "example"
    map_path = ROOT / ("maps/xian_map.ply" if use_example_map else "tests/fixtures/rotation-map.ply")
    source_hash = hashlib.sha256(map_path.read_bytes()).hexdigest()
    cache_root = ROOT / ".atlas-cache/surfaces/adaptive-voxel-v1"
    surface_cache_path = cache_root / f"{source_hash}.atsurface.gz"
    metadata_cache_path = cache_root / f"{source_hash}.json"
    if not use_example_map and os.environ.get("KEEP_SURFACE_CACHE") != "1":
        surface_cache_path.unlink(missing_ok=True)
        metadata_cache_path.unlink(missing_ok=True)
    cache_existed_before_load = surface_cache_path.exists() and metadata_cache_path.exists()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(180_000)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )

        page.goto(BASE_URL, wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        if use_example_map:
            page.get_by_role("button", name="示例地图").click()
        else:
            page.locator('input[type="file"][accept=".ply"]').set_input_files(
                str(ROOT / "tests/fixtures/rotation-map.ply")
            )
        canvas = page.get_by_label("三维点云交互画布")
        canvas.wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")

        toggle = page.get_by_role("button", name="切换地图显示模式")
        assert toggle.is_visible()
        assert toggle.get_attribute("data-map-render-mode") == "points"
        assert "点云" in toggle.inner_text()
        initial = canvas_snapshot(canvas)
        assert initial["data-map-render-mode"] == "points"
        assert initial["data-map-point-cloud-visible"] == "true"
        assert initial["data-map-surface-visible"] == "false"
        assert initial["data-map-render-isolation"] == "scene-map-only"
        assert initial["data-robot-layer-render-isolation"] == "independent"

        toggle.click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.mapSurfaceStatus === 'ready'"
        )
        assert toggle.get_attribute("data-map-render-mode") == "surface"
        assert "结构面" in toggle.inner_text()
        surface_without_robot = canvas_snapshot(canvas)
        assert surface_without_robot["data-map-point-cloud-visible"] == "false"
        assert surface_without_robot["data-map-surface-visible"] == "true"
        assert surface_without_robot["data-map-surface-implementation"] == "adaptive-voxel-triangle-mesh"
        assert surface_without_robot["data-map-surface-primitive"] == "triangles"
        assert surface_without_robot["data-map-surface-status"] == "ready"
        assert surface_without_robot["data-map-surface-cache-hit"] == (
            "true" if cache_existed_before_load else "false"
        )
        assert surface_without_robot["data-map-source-hash"] == source_hash
        assert int(surface_without_robot["data-map-surface-cell-count"]) > 0
        assert int(surface_without_robot["data-map-surface-triangle-count"]) >= 12
        assert float(surface_without_robot["data-map-surface-voxel-size"]) > 0
        metadata = json.loads(metadata_cache_path.read_text())
        assert metadata["sourceHash"] == source_hash
        assert metadata["algorithm"] == "adaptive-voxel-surface-fusion-v1"
        assert surface_cache_path.stat().st_size > 0

        page.get_by_role("button", name="加载机器人", exact=True).click()
        page.get_by_role("option", name="加载机器人 botx_abx_zivid_m70").click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )
        loaded_surface = canvas_snapshot(canvas)
        assert loaded_surface["data-map-render-mode"] == "surface"
        assert loaded_surface["data-robot-layer-visible"] == "true"
        robot_metadata = {
            key: value for key, value in loaded_surface.items() if key.startswith("data-robot-")
        }

        toggle.click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.mapRenderMode === 'points'"
        )
        loaded_points = canvas_snapshot(canvas)
        assert loaded_points["data-map-point-cloud-visible"] == "true"
        assert loaded_points["data-map-surface-visible"] == "false"
        assert {
            key: value for key, value in loaded_points.items() if key.startswith("data-robot-")
        } == robot_metadata

        toggle.click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.mapSurfaceStatus === 'ready'"
        )
        page.wait_for_timeout(500)
        page.screenshot(
            path=(
                "/tmp/atlas-map-surface-example.png"
                if use_example_map
                else "/tmp/atlas-map-surface.png"
            ),
            full_page=True,
        )

        page.reload(wait_until="domcontentloaded")
        page.locator('[data-session-state="ready"]').wait_for()
        canvas = page.get_by_label("三维点云交互画布")
        canvas.wait_for()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.mapSurfaceStatus === 'ready'"
        )
        assert canvas.get_attribute("data-map-render-mode") == "surface"
        assert canvas.get_attribute("data-map-surface-cache-hit") == "true"
        assert canvas.get_attribute("data-map-source-hash") == source_hash
        assert page.get_by_role("button", name="切换地图显示模式").get_attribute(
            "data-map-render-mode"
        ) == "surface"

        print("map_render_mode=", canvas.get_attribute("data-map-render-mode"))
        print("robot_layer_visible=", canvas.get_attribute("data-robot-layer-visible"))
        print("page_errors=", errors)
        print("console_errors=", console_errors)
        assert not errors
        assert not console_errors
        browser.close()


if __name__ == "__main__":
    run()
