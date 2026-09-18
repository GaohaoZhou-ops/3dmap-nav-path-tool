import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
ROOT = Path(__file__).resolve().parents[1]


def read_map_cache(page):
    return page.evaluate(
        """async () => {
          const database = await new Promise((resolve, reject) => {
            const request = indexedDB.open('atlas-route-studio', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          return await new Promise((resolve, reject) => {
            const transaction = database.transaction('workspace-session', 'readonly');
            const request = transaction.objectStore('workspace-session').get('workspace-map:map');
            request.onsuccess = () => {
              const record = request.result;
              resolve({
                geometryCacheVersion: record?.geometryCacheVersion || 0,
                pointCount: record?.pointCount || 0,
                faceCount: record?.faceCount || 0,
                indexByteLength: record?.indexBuffer?.byteLength || 0,
                indexComponentType: record?.indexComponentType || '',
              });
            };
            request.onerror = () => reject(request.error);
          });
        }"""
    )


def assert_hybrid_geometry(page, canvas, source, quality="auto"):
    assert canvas.get_attribute("data-geometry-source") == source
    assert canvas.get_attribute("data-map-render-mode") == "hybrid-mesh-points"
    assert canvas.get_attribute("data-map-point-cloud-visible") == "true"
    assert canvas.get_attribute("data-ply-mesh-visible") == "true"
    assert canvas.get_attribute("data-ply-mesh-face-count") == "2"
    assert canvas.get_attribute("data-ply-mesh-referenced-point-count") == "4"
    assert canvas.get_attribute("data-ply-unmeshed-point-count") == "3"
    assert canvas.get_attribute("data-renderable-point-count") == "3"
    assert canvas.get_attribute("data-render-point-count") == "3"
    assert canvas.get_attribute("data-ply-mesh-render-strategy") == (
        "indexed-mesh+unreferenced-points"
    )
    assert canvas.get_attribute("data-mesh-render-quality") == quality
    assert canvas.get_attribute("data-render-mesh-face-count") == "2"
    assert page.get_by_role("button", name="切换地图显示模式").count() == 0
    mesh_status = page.get_by_role(
        "status",
        name="PLY 内嵌网格 2 个三角面，另有 3 个未成面点",
    )
    mesh_status.wait_for()
    assert "PLY MESH" in mesh_status.inner_text()
    assert "2 TRI" in mesh_status.inner_text()


def run():
    page_errors = []
    console_errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1600, "height": 960})
        page = context.new_page()
        page.set_default_timeout(180_000)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )

        page.goto(f"{BASE_URL.rstrip('/')}/workbench", wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator('input[type="file"][accept=".ply"]').set_input_files(
            str(ROOT / "tests/fixtures/hybrid-map.ply")
        )
        canvas = page.get_by_label("三维点云交互画布")
        canvas.wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        assert_hybrid_geometry(page, canvas, "ply-parse")
        assert canvas.get_attribute("data-ply-mesh-color-mode") == "height"
        quality_select = page.get_by_label("网格渲染质量", exact=True)
        assert quality_select.input_value() == "auto"
        quality_select.select_option("performance")
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.meshRenderQuality === 'performance'"
        )
        assert canvas.get_attribute("data-mesh-face-budget") == "180000"

        color_button = page.get_by_role("button", name="切换点云颜色模式")
        color_button.click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.plyMeshColorMode === 'source'"
        )

        cache = read_map_cache(page)
        assert cache["geometryCacheVersion"] == 1
        assert cache["pointCount"] == 7
        assert cache["faceCount"] == 2
        assert cache["indexByteLength"] == 12
        assert cache["indexComponentType"] == "uint16"
        page.screenshot(path="/tmp/atlas-hybrid-ply-mesh.png", full_page=True)

        page.reload(wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        canvas = page.get_by_label("三维点云交互画布")
        canvas.wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        assert_hybrid_geometry(page, canvas, "session-cache", "performance")
        assert page.get_by_label("网格渲染质量", exact=True).input_value() == "performance"

        print("hybrid_cache=", cache)
        print("page_errors=", page_errors)
        print("console_errors=", console_errors)
        assert not page_errors
        assert not console_errors
        context.close()
        browser.close()


if __name__ == "__main__":
    run()
