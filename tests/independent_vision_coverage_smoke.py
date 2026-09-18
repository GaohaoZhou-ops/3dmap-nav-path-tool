import os
from io import BytesIO
from pathlib import Path

from playwright.sync_api import sync_playwright
from PIL import Image, ImageChops, ImageStat


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990").rstrip("/")
ROOT = Path(__file__).resolve().parents[1]
CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")


def image_pixel_difference(left_png, right_png):
    with Image.open(BytesIO(left_png)).convert("RGB") as left:
        with Image.open(BytesIO(right_png)).convert("RGB") as right:
            difference = ImageChops.difference(left, right)
            return {
                "maximum": max(channel[1] for channel in difference.getextrema()),
                "mean": max(ImageStat.Stat(difference).mean),
            }


def coverage_metrics(canvas):
    return {
        "state": canvas.get_attribute("data-vision-coverage-state"),
        "mode": canvas.get_attribute("data-vision-coverage-mode"),
        "surface_stop": canvas.get_attribute("data-vision-coverage-surface-stop"),
        "visual_mode": canvas.get_attribute("data-vision-coverage-visual-mode"),
        "outline_mode": canvas.get_attribute("data-vision-coverage-outline-mode"),
        "internal_rays": canvas.get_attribute("data-vision-coverage-internal-rays"),
        "infinite": canvas.get_attribute("data-vision-coverage-infinite"),
        "poses": int(canvas.get_attribute("data-vision-coverage-pose-count") or 0),
        "frames": int(canvas.get_attribute("data-vision-coverage-frame-count") or 0),
        "optical_points": int(
            canvas.get_attribute("data-vision-coverage-optical-point-count") or 0
        ),
        "coordinate_frames": int(
            canvas.get_attribute("data-vision-coverage-coordinate-frame-count") or 0
        ),
        "coordinate_axes": int(
            canvas.get_attribute("data-vision-coverage-coordinate-axis-count") or 0
        ),
        "retention_mode": canvas.get_attribute(
            "data-vision-coverage-retention-mode"
        ),
        "optical_pose_signature": canvas.get_attribute(
            "data-vision-coverage-optical-pose-signature"
        ),
        "cells": int(canvas.get_attribute("data-vision-coverage-cell-count") or 0),
        "hit_cells": int(
            canvas.get_attribute("data-vision-coverage-hit-cell-count") or 0
        ),
        "minimum_depth": float(
            canvas.get_attribute("data-vision-coverage-minimum-depth") or 0
        ),
        "maximum_depth": float(
            canvas.get_attribute("data-vision-coverage-maximum-depth") or 0
        ),
    }


def run():
    page_errors = []
    console_errors = []
    with sync_playwright() as playwright:
        options = {"headless": True}
        if CHROME.exists():
            options["executable_path"] = str(CHROME)
        browser = playwright.chromium.launch(**options)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(180_000)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "console",
            lambda message: console_errors.append(
                f"{message.text} @ {message.location.get('url', '')}"
            )
            if message.type == "error"
            else None,
        )
        page.on("dialog", lambda dialog: dialog.accept())

        page.goto(f"{BASE_URL}/workbench", wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.locator('[data-independent-teaching-input="true"]').set_input_files(
            str(ROOT / "tests/fixtures/hybrid-camera-surface-map.ply")
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.teachingSpaceMode === 'independent'"
        )

        canvas = page.locator(".three-canvas")
        assert canvas.get_attribute("data-vision-coverage-state") == "empty"
        page.get_by_role("button", name="加载机器人", exact=True).click()
        page.get_by_role(
            "option", name="加载机器人 botx_abx_zivid_m70"
        ).click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )

        page.get_by_role("tab", name="虚拟示教与相机").click()
        page.wait_for_function(
            "document.querySelector('.zivid-camera-canvas')?.dataset.contextState === 'ready'"
        )
        zivid_canvas = page.locator(".zivid-camera-canvas")
        assert zivid_canvas.get_attribute("data-teaching-surface-tint") == "disabled"
        assert (
            zivid_canvas.get_attribute("data-surface-appearance-source")
            == "original-map-geometry"
        )
        zivid_before_capture = zivid_canvas.screenshot(
            path="/tmp/atlas-zivid-before-surface-tint.png"
        )
        page.get_by_role("button", name="新建示教任务", exact=True).click()
        create_dialog = page.get_by_role("dialog", name="新建示教任务")
        create_dialog.get_by_role("textbox", name="新示教任务名称").fill(
            "独立示教覆盖检查"
        )
        parking_option = create_dialog.get_by_role(
            "button", name="添加当前位置为停车点"
        )
        parking_option.click()
        create_dialog.get_by_role("button", name="创建任务", exact=True).click()

        page.get_by_role("button", name="记录当前机械臂姿态").click()
        page.wait_for_function(
            "document.querySelector('[aria-label=\"虚拟示教\"]')?.dataset.cameraCaptureStatus === 'complete'",
            timeout=180_000,
        )
        page.wait_for_timeout(800)
        print("coverage_after_capture=", coverage_metrics(canvas), flush=True)
        page.wait_for_function(
            "Number(document.querySelector('.three-canvas')?.dataset.visionCoverageFrameCount) === 2",
            timeout=30_000,
        )
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.teachingSurfaceTintState === 'visible'",
            timeout=30_000,
        )

        metrics = coverage_metrics(canvas)
        assert metrics["state"] == "visible"
        assert metrics["mode"] == "surface-truncated-optical-frusta"
        assert metrics["surface_stop"] == "first-point-depth-grid"
        assert metrics["visual_mode"] == "continuous-volume"
        assert metrics["outline_mode"] == "outer-silhouette"
        assert metrics["internal_rays"] == "false"
        assert metrics["infinite"] == "false"
        assert metrics["poses"] == 1
        assert metrics["frames"] == 2
        assert metrics["optical_points"] == 2
        assert metrics["coordinate_frames"] == 2
        assert metrics["coordinate_axes"] == 6
        assert metrics["retention_mode"] == "captured-pose-static"
        assert metrics["optical_pose_signature"]
        assert metrics["cells"] > 0
        assert 0 < metrics["hit_cells"] < metrics["cells"]
        assert 0.3 <= metrics["minimum_depth"] <= metrics["maximum_depth"]
        assert metrics["maximum_depth"] <= 1.3 + 1e-3
        first_surface_tint_count = int(
            canvas.get_attribute("data-teaching-surface-tint-covered-point-count") or 0
        )
        assert first_surface_tint_count > 0
        assert canvas.get_attribute("data-teaching-surface-tint-overlap-mode") == "binary-union"
        assert canvas.get_attribute("data-teaching-surface-tint-maximum-weight") == "1"
        assert canvas.get_attribute("data-teaching-surface-tint-opacity") == "0.2"
        assert (
            canvas.get_attribute("data-teaching-surface-tint-camera-isolation")
            == "main-view-only"
        )
        zivid_after_first_capture = zivid_canvas.screenshot(
            path="/tmp/atlas-zivid-after-surface-tint.png"
        )
        first_camera_difference = image_pixel_difference(
            zivid_before_capture,
            zivid_after_first_capture,
        )
        assert first_camera_difference["maximum"] <= 1
        assert first_camera_difference["mean"] <= 0.5

        # Record the identical pose again. The number of viewing volumes grows,
        # while the binary surface-union mask must retain the same intensity and size.
        page.get_by_role("button", name="记录当前机械臂姿态").click()
        page.wait_for_function(
            """
            () => {
              const canvas = document.querySelector('.three-canvas');
              return Number(canvas?.dataset.visionCoverageFrameCount) === 4
                && canvas?.dataset.teachingSurfaceTintState === 'visible'
                && canvas?.dataset.teachingSurfaceTintProgress === '1';
            }
            """,
            timeout=30_000,
        )
        overlap_metrics = coverage_metrics(canvas)
        assert overlap_metrics["poses"] == 2
        assert overlap_metrics["frames"] == 4
        assert overlap_metrics["optical_points"] == 4
        assert overlap_metrics["coordinate_frames"] == 4
        assert overlap_metrics["coordinate_axes"] == 12
        captured_optical_pose_signature = overlap_metrics["optical_pose_signature"]
        assert captured_optical_pose_signature
        assert int(
            canvas.get_attribute("data-teaching-surface-tint-covered-point-count") or 0
        ) == first_surface_tint_count
        assert canvas.get_attribute("data-teaching-surface-tint-maximum-weight") == "1"
        assert canvas.get_attribute("data-teaching-surface-tint-opacity") == "0.2"
        zivid_after_overlap_capture = zivid_canvas.screenshot()
        overlap_camera_difference = image_pixel_difference(
            zivid_before_capture,
            zivid_after_overlap_capture,
        )
        assert overlap_camera_difference["maximum"] <= 1
        assert overlap_camera_difference["mean"] <= 0.5

        readout = page.get_by_label("独立示教相机视觉覆盖范围", exact=True)
        assert readout.is_visible()
        assert readout.get_attribute("data-coverage-pose-count") == "2"
        assert readout.get_attribute("data-coverage-frame-count") == "4"
        assert readout.get_attribute("data-coverage-optical-point-count") == "4"
        assert readout.get_attribute("data-coverage-coordinate-frame-count") == "4"
        assert readout.get_attribute("data-coverage-coordinate-axis-count") == "12"
        assert readout.get_attribute("data-surface-tint-state") == "visible"
        assert readout.get_attribute("data-surface-tint-point-count") == str(
            first_surface_tint_count
        )
        robot_position_before_move = (
            float(canvas.get_attribute("data-robot-x") or 0),
            float(canvas.get_attribute("data-robot-y") or 0),
            float(canvas.get_attribute("data-robot-z") or 0),
        )
        page.get_by_role("button", name="定位机器人模型", exact=True).click()
        page.keyboard.down("d")
        page.wait_for_timeout(1400)
        page.keyboard.up("d")
        page.wait_for_function(
            """
            ([x, y, z]) => {
              const canvas = document.querySelector('.three-canvas');
              return Math.hypot(
                Number(canvas?.dataset.robotX) - x,
                Number(canvas?.dataset.robotY) - y,
                Number(canvas?.dataset.robotZ) - z,
              ) > 0.25;
            }
            """,
            arg=list(robot_position_before_move),
        )
        moved_metrics = coverage_metrics(canvas)
        assert moved_metrics["optical_pose_signature"] == captured_optical_pose_signature
        assert moved_metrics["optical_points"] == 4
        assert moved_metrics["coordinate_frames"] == 4
        assert moved_metrics["coordinate_axes"] == 12
        page.get_by_role("button", name="原点", exact=True).click()
        page.wait_for_timeout(800)
        page.screenshot(path="/tmp/atlas-independent-vision-coverage.png", full_page=True)

        page.wait_for_timeout(900)
        page.reload(wait_until="domcontentloaded")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )
        page.wait_for_function(
            """
            () => {
              const canvas = document.querySelector('.three-canvas');
              return Number(canvas?.dataset.visionCoverageFrameCount) === 4
                && canvas?.dataset.teachingSurfaceTintState === 'visible';
            }
            """
        )
        restored = coverage_metrics(page.locator(".three-canvas"))
        assert restored["state"] == "visible"
        assert restored["poses"] == 2
        assert restored["frames"] == 4
        assert restored["optical_points"] == 4
        assert restored["coordinate_frames"] == 4
        assert restored["coordinate_axes"] == 12
        assert restored["retention_mode"] == "captured-pose-static"
        assert restored["optical_pose_signature"] == captured_optical_pose_signature
        assert restored["cells"] == overlap_metrics["cells"]
        assert int(
            page.locator(".three-canvas").get_attribute(
                "data-teaching-surface-tint-covered-point-count"
            )
            or 0
        ) == first_surface_tint_count

        print("coverage_metrics=", metrics)
        print("overlap_coverage_metrics=", overlap_metrics)
        print("moved_coverage_metrics=", moved_metrics)
        print("surface_tint_points=", first_surface_tint_count)
        print("zivid_first_difference=", first_camera_difference)
        print("zivid_overlap_difference=", overlap_camera_difference)
        print("restored_coverage_metrics=", restored)
        print("page_errors=", page_errors)
        print("console_errors=", console_errors)
        assert not page_errors
        assert not console_errors
        browser.close()


if __name__ == "__main__":
    run()
