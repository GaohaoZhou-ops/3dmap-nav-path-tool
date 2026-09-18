import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
ROOT = Path(__file__).resolve().parents[1]


def vector_attribute(locator, name):
    return tuple(float(value) for value in locator.get_attribute(name).split(","))


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(180_000)
        page.on("pageerror", lambda error: errors.append(str(error)))

        page.goto(f"{BASE_URL.rstrip('/')}/workbench", wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        assert page.get_by_label("Zivid 2 M70 相机视图").count() == 0

        page.locator('input[type="file"][accept=".ply"]').set_input_files(
            str(ROOT / "tests/fixtures/rotation-map.ply")
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.get_by_role("button", name="加载机器人", exact=True).click()
        page.get_by_role("option", name="加载机器人 botx_abx_zivid_m70").click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )

        main_canvas = page.locator(".three-canvas")
        teaching_tab = page.get_by_role("tab", name="虚拟示教与相机")
        teaching_tab.click()
        assert teaching_tab.get_attribute("aria-selected") == "true"
        assert page.get_by_label("全关节控制浮动窗口", exact=True).count() == 0
        panel = page.get_by_label("Zivid 2 M70 相机视图")
        panel.scroll_into_view_if_needed()
        panel.wait_for()
        assert page.get_by_label("主3D辅助视角").count() == 0
        assert panel.get_attribute("data-zivid-model") == "zivid-2-m70"
        assert panel.get_attribute("data-horizontal-fov") == "56.6"
        assert panel.get_attribute("data-vertical-fov") == "35.6"
        assert panel.get_attribute("data-working-near") == "0.3"
        assert panel.get_attribute("data-working-far") == "1.3"
        assert panel.get_attribute("data-native-resolution") == "1944x1200"
        assert panel.get_attribute("data-optical-frame") == "zivid_left_optical_frame"
        page.wait_for_function(
            "document.querySelector('[data-zivid-model=\"zivid-2-m70\"]')?.dataset.rendererStatus === 'ready'"
        )
        camera_canvas = panel.locator(".zivid-camera-canvas")
        assert camera_canvas.get_attribute("data-camera-ready") == "true"
        assert camera_canvas.get_attribute("data-render-mode") == "rgb"
        assert int(camera_canvas.get_attribute("data-render-point-count")) > 0

        panel.get_by_role("button", name="点云", exact=True).click()
        page.wait_for_function(
            "document.querySelector('[data-zivid-model=\"zivid-2-m70\"]')?.dataset.renderMode === 'pointcloud'"
        )
        assert camera_canvas.get_attribute("data-render-mode") == "pointcloud"
        assert panel.get_by_label("点云深度色标").is_visible()

        panel.get_by_role("button", name="放大相机画面").click()
        panel.get_by_role("button", name="放大相机画面").click()
        page.wait_for_function(
            "Number(document.querySelector('[data-zivid-model=\"zivid-2-m70\"]')?.dataset.zoom) > 2"
        )
        assert float(camera_canvas.get_attribute("data-digital-zoom")) > 2

        panel.get_by_role("button", name="右臂 M70").click()
        page.wait_for_function(
            "document.querySelector('[data-zivid-model=\"zivid-2-m70\"]')?.dataset.opticalFrame === 'zivid_right_optical_frame'"
        )
        panel = page.get_by_label("Zivid 2 M70 相机视图")
        assert panel.get_attribute("data-camera-side") == "right"
        assert panel.get_attribute("data-zoom") == "1.00"

        before_position = vector_attribute(main_canvas, "data-zivid-right-optical-position")
        before_revision = int(main_canvas.get_attribute("data-zivid-camera-pose-revision"))
        page.get_by_role("button", name="定位机器人模型").click()
        page.keyboard.press("w")
        page.wait_for_function(
            "([revision]) => Number(document.querySelector('.three-canvas')?.dataset.zividCameraPoseRevision) > revision",
            arg=[before_revision],
        )
        after_position = vector_attribute(main_canvas, "data-zivid-right-optical-position")
        assert any(abs(after - before) > 0.02 for after, before in zip(after_position, before_position))

        page.get_by_role("button", name="放大 Zivid 相机视图").click()
        dialog = page.get_by_role("dialog", name="Zivid 2 M70 相机大图")
        dialog.wait_for()
        expanded_panel = dialog.get_by_label("Zivid 2 M70 相机视图")
        assert expanded_panel.is_visible()
        assert expanded_panel.locator(".zivid-camera-canvas").is_visible()
        camera_stage = dialog.get_by_label("Zivid相机主画面", exact=True)
        side_stack = dialog.get_by_label("相机控制与主3D辅助区", exact=True)
        camera_controls = dialog.get_by_label("相机视角反算示教", exact=True)
        preview = dialog.get_by_label("主3D辅助视角", exact=True)
        preview.wait_for()
        camera_viewport = dialog.get_by_label("M70 相机画面交互区", exact=True)
        stage_bounds = camera_stage.bounding_box()
        side_stack_bounds = side_stack.bounding_box()
        controls_bounds = camera_controls.bounding_box()
        camera_bounds = camera_viewport.bounding_box()
        preview_bounds = preview.bounding_box()
        assert all((stage_bounds, side_stack_bounds, controls_bounds, camera_bounds, preview_bounds))
        assert abs(side_stack_bounds["x"] - (stage_bounds["x"] + stage_bounds["width"])) < 3
        assert stage_bounds["width"] > side_stack_bounds["width"] * 1.75
        assert controls_bounds["y"] < preview_bounds["y"]
        assert controls_bounds["y"] + controls_bounds["height"] <= preview_bounds["y"] + 3
        assert abs(controls_bounds["x"] - preview_bounds["x"]) < 3
        assert abs(controls_bounds["width"] - preview_bounds["width"]) < 3
        assert camera_bounds["x"] >= stage_bounds["x"] - 1
        assert camera_bounds["y"] >= stage_bounds["y"] - 1
        assert camera_bounds["x"] + camera_bounds["width"] <= stage_bounds["x"] + stage_bounds["width"] + 1
        assert camera_bounds["y"] + camera_bounds["height"] <= stage_bounds["y"] + stage_bounds["height"] + 1
        assert abs((camera_bounds["width"] / camera_bounds["height"]) - (1944 / 1200)) < 0.01
        assert camera_stage.get_attribute("data-native-aspect-ratio") == "1944:1200"
        assert camera_stage.get_attribute("data-view-layout") == "native-aspect-camera"
        assert side_stack.get_attribute("data-stack-order") == "camera-controls,main-3d"
        assert preview.get_attribute("data-preview-layout") == "below-camera-controls"
        assert expanded_panel.get_attribute("data-expanded-layout") == "camera-priority"
        assert expanded_panel.get_attribute("data-main-view-preview") == "below-camera-controls"
        expanded_camera_canvas = expanded_panel.locator(".zivid-camera-canvas")
        page.wait_for_function(
            """() => {
              const canvas = document.querySelector('.zivid-camera-panel.is-expanded .zivid-camera-canvas');
              return canvas?.height > 0 && Math.abs((canvas.width / canvas.height) - (1944 / 1200)) < 0.02;
            }"""
        )
        canvas_bounds = expanded_camera_canvas.bounding_box()
        assert canvas_bounds
        assert abs(canvas_bounds["width"] - camera_bounds["width"]) < 1
        assert abs(canvas_bounds["height"] - camera_bounds["height"]) < 1
        page.wait_for_function(
            """() => document.querySelector('.zivid-main-view-preview')
              ?.dataset.previewStatus === 'live'"""
        )
        assert preview.get_attribute("data-preview-transport") in {
            "capture-stream",
            "canvas-copy",
        }
        assert preview.get_attribute("data-preview-source") == "three-canvas"
        assert int(preview.get_attribute("data-preview-source-width")) > 0
        assert int(preview.get_attribute("data-preview-source-height")) > 0
        initial_preview_frame = int(preview.get_attribute("data-preview-frame-count"))
        page.wait_for_function(
            """frame => Number(document.querySelector('.zivid-main-view-preview')
              ?.dataset.previewFrameCount) > frame""",
            arg=initial_preview_frame,
        )
        page.wait_for_function(
            """() => {
              const preview = document.querySelector('.zivid-main-view-preview');
              const source = document.querySelector('.three-canvas');
              return Boolean(preview?.dataset.sourceViewSignature)
                && preview.dataset.sourceViewSignature === source?.dataset.viewSignature;
            }"""
        )
        assert preview.get_attribute("data-preview-zoom") == "1.00"
        assert preview.get_attribute("data-preview-max-zoom") == "8"
        camera_zoom_before = expanded_panel.get_attribute("data-zoom")
        preview.get_by_role("button", name="放大主3D视角").click()
        preview.get_by_role("button", name="放大主3D视角").click()
        page.wait_for_function(
            """() => Number(document.querySelector('.zivid-main-view-preview')
              ?.dataset.previewZoom) > 2"""
        )
        preview_transport = preview.get_attribute("data-preview-transport")
        preview_media = preview.locator(
            "video" if preview_transport == "capture-stream" else "canvas"
        )
        page.wait_for_timeout(220)
        assert preview_media.evaluate(
            "node => getComputedStyle(node).transform !== 'none'"
        )
        assert expanded_panel.get_attribute("data-zoom") == camera_zoom_before

        preview.get_by_role("button", name="重置主3D视角缩放").click()
        assert preview.get_attribute("data-preview-zoom") == "1.00"
        preview_frame = preview.locator(".zivid-main-view-preview__frame")
        frame_bounds = preview_frame.bounding_box()
        assert frame_bounds
        page.mouse.move(
            frame_bounds["x"] + frame_bounds["width"] * 0.32,
            frame_bounds["y"] + frame_bounds["height"] * 0.68,
        )
        page.mouse.wheel(0, -520)
        page.wait_for_function(
            """() => Number(document.querySelector('.zivid-main-view-preview')
              ?.dataset.previewZoom) > 1"""
        )
        assert expanded_panel.get_attribute("data-zoom") == camera_zoom_before
        page.screenshot(path="/tmp/atlas-zivid-m70-camera.png", full_page=True)
        preview_frame.dblclick(position={"x": 28, "y": frame_bounds["height"] - 28})
        assert preview.get_attribute("data-preview-zoom") == "1.00"

        assert preview.get_attribute("data-preview-interaction-mode") == "rotate"
        view_before_rotate = main_canvas.get_attribute("data-view-signature")
        rotate_count_before = int(
            main_canvas.get_attribute("data-preview-rotate-control-count") or 0
        )
        page.mouse.move(
            frame_bounds["x"] + frame_bounds["width"] * 0.46,
            frame_bounds["y"] + frame_bounds["height"] * 0.42,
        )
        page.mouse.down()
        page.mouse.move(
            frame_bounds["x"] + frame_bounds["width"] * 0.62,
            frame_bounds["y"] + frame_bounds["height"] * 0.53,
            steps=4,
        )
        page.mouse.up()
        page.wait_for_function(
            """([signature, count]) => {
              const canvas = document.querySelector('.three-canvas');
              return canvas?.dataset.viewSignature !== signature
                && Number(canvas?.dataset.previewRotateControlCount || 0) > count;
            }""",
            arg=[view_before_rotate, rotate_count_before],
        )
        assert main_canvas.get_attribute("data-preview-control-mode") == "rotate"

        preview.get_by_role("button", name="主3D视角平移模式").click()
        assert preview.get_attribute("data-preview-interaction-mode") == "pan"
        view_before_pan = main_canvas.get_attribute("data-view-signature")
        pan_count_before = int(
            main_canvas.get_attribute("data-preview-pan-control-count") or 0
        )
        page.mouse.move(
            frame_bounds["x"] + frame_bounds["width"] * 0.55,
            frame_bounds["y"] + frame_bounds["height"] * 0.46,
        )
        page.mouse.down()
        page.mouse.move(
            frame_bounds["x"] + frame_bounds["width"] * 0.43,
            frame_bounds["y"] + frame_bounds["height"] * 0.58,
            steps=4,
        )
        page.mouse.up()
        page.wait_for_function(
            """([signature, count]) => {
              const canvas = document.querySelector('.three-canvas');
              return canvas?.dataset.viewSignature !== signature
                && Number(canvas?.dataset.previewPanControlCount || 0) > count;
            }""",
            arg=[view_before_pan, pan_count_before],
        )
        assert main_canvas.get_attribute("data-preview-control-mode") == "pan"
        assert expanded_panel.get_attribute("data-zoom") == camera_zoom_before
        page.screenshot(path="/tmp/atlas-zivid-m70-camera.png", full_page=True)
        expanded_panel.get_by_role("button", name="关闭 Zivid 相机大图").click()
        dialog.wait_for(state="detached")

        assert not errors, errors
        browser.close()


if __name__ == "__main__":
    run()
