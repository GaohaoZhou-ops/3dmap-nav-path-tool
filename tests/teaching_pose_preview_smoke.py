import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
ROOT = Path(__file__).resolve().parents[1]
CHROMIUM_EXECUTABLE = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE")
FIXTURE = ROOT / "tests/fixtures/teaching-pose-preview.json"


def run():
    errors = []
    console_errors = []
    with sync_playwright() as playwright:
        launch_options = {"headless": True}
        if CHROMIUM_EXECUTABLE:
            launch_options["executable_path"] = CHROMIUM_EXECUTABLE
        browser = playwright.chromium.launch(**launch_options)
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        page.set_default_timeout(180_000)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )

        page.goto(f"{BASE_URL.rstrip('/')}/workbench", wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.locator('input[type="file"][accept*=".json"]').set_input_files(str(FIXTURE))
        page.get_by_text("工程配置已加载", exact=False).wait_for()
        page.get_by_role("button", name="打开示教数据管理页").click()
        page.locator('[data-app-page="teaching-data"]').wait_for(timeout=15_000)

        assert page.get_by_text("归档上下文", exact=True).count() == 0
        assert page.get_by_label("示教归档上下文").count() == 0

        archive = page.locator(".teaching-data-page__archive")
        preview = page.get_by_label("机器人示教姿态三维预览")
        tree_pane = page.get_by_label("示教层级树")
        archive_box = archive.bounding_box()
        preview_box = preview.bounding_box()
        tree_pane_box = tree_pane.bounding_box()
        assert archive_box and preview_box and tree_pane_box
        assert archive_box["width"] > 850
        assert tree_pane_box["width"] >= 349
        assert preview_box["width"] >= 390
        assert preview_box["x"] > archive_box["x"] + archive_box["width"]

        # Selecting a task clears the pose preview; selecting a leaf restores
        # the archived base orientation and all recorded URDF joint values.
        page.get_by_role("button", name="选择示教任务 预览验证任务").click()
        page.wait_for_function(
            "document.querySelector('.teaching-pose-robot-preview')?.dataset.poseId === ''"
        )
        assert page.get_by_text("选择一组机械臂姿态", exact=True).is_visible()

        page.get_by_role("button", name="查看机械臂姿态 A01 检查姿态").click()
        page.wait_for_function(
            "document.querySelector('.teaching-pose-robot-preview')?.dataset.previewState === 'ready'"
        )
        page.wait_for_function(
            "document.querySelector('.teaching-pose-robot-canvas')?.dataset.poseId === 'preview-pose'"
        )

        assert preview.get_attribute("data-pose-id") == "preview-pose"
        assert preview.get_attribute("data-scene-content") == "robot-only"
        assert preview.get_attribute("data-environment-point-cloud") == "false"
        assert preview.get_attribute("data-environment-mesh") == "false"
        assert page.get_by_text("ROBOT ONLY", exact=True).is_visible()
        assert page.get_by_text("停车点 P01 / A01 检查姿态", exact=True).is_visible()
        assert float(page.locator(".teaching-data-page__hero h1").evaluate(
            "element => getComputedStyle(element).fontSize.replace('px', '')"
        )) >= 27
        assert float(page.locator(".teaching-tree-label > span").first.evaluate(
            "element => getComputedStyle(element).fontSize.replace('px', '')"
        )) >= 12
        assert float(page.locator(".teaching-tree-pose-values strong").first.evaluate(
            "element => getComputedStyle(element).fontSize.replace('px', '')"
        )) >= 12
        assert float(preview.locator("header strong").first.evaluate(
            "element => getComputedStyle(element).fontSize.replace('px', '')"
        )) >= 12

        canvas = page.get_by_label("所选示教姿态机器人三维模型")
        assert float(canvas.get_attribute("data-map-x")) == 2.4
        assert float(canvas.get_attribute("data-map-y")) == -1.25
        assert float(canvas.get_attribute("data-map-z")) == 0.08
        assert float(canvas.get_attribute("data-map-roll")) == 1.5
        assert float(canvas.get_attribute("data-map-pitch")) == -2.25
        assert float(canvas.get_attribute("data-map-yaw")) == 32
        applied = json.loads(canvas.get_attribute("data-applied-joint-values"))
        for name, expected in {
            "waist_pitch_J": 7.5,
            "waist_yaw_J": -11,
            "left_J1": 24,
            "left_J2": -38,
            "right_J1": -19,
            "right_J2": 31,
        }.items():
            assert abs(applied[name] - expected) < 1e-6

        reset_button = page.get_by_role("button", name="重置机器人姿态预览视角")
        assert reset_button.is_enabled()
        reset_button.click()
        page.screenshot(path="/tmp/atlas-teaching-pose-robot-preview.png", full_page=True)

        assert not errors
        assert not console_errors
        browser.close()


if __name__ == "__main__":
    run()
