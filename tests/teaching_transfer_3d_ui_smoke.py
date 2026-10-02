import math
import re

from playwright.sync_api import sync_playwright
from teaching_transfer_ui_smoke import CHROME, seed, ready, snapshot, open_transfer


def values(dialog, prefix):
    return [float(dialog.get_by_label(f"{prefix} {axis}", exact=True).input_value()) for axis in ["X", "Y", "Z", "Roll", "Pitch", "Yaw"]]


def drag_axis(page, dialog, axis, dx=35, dy=-20):
    canvas = dialog.get_by_label("地图转换三维预览", exact=True)
    canvas.scroll_into_view_if_needed()
    box = canvas.bounding_box()
    center_x, center_y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    # Locate a real Three.js handle by its hover state, then drag it with normal
    # pointer events. This tests the same raycast and camera arbitration as users.
    for radius in [24, 36, 48, 60, 72, 84, 96, 108]:
        for degrees in range(0, 360, 15):
            x = center_x + radius * math.cos(math.radians(degrees))
            y = center_y + radius * math.sin(math.radians(degrees))
            page.mouse.move(x, y)
            if canvas.get_attribute("data-gizmo-axis") == axis:
                page.mouse.down()
                page.mouse.move(x + dx, y + dy, steps=10)
                page.mouse.up()
                return
    page.screenshot(path="/tmp/transfer-3d-missing-handle.png", full_page=True)
    raise AssertionError(f"No {axis} gizmo handle found")


def run():
    errors, shader_errors = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, **({"executable_path": str(CHROME)} if CHROME.exists() else {}))
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("console", lambda message: shader_errors.append(message.text) if message.type == "error" and "THREE" in message.text else None)
            seed(page, ["map", "independent"], "independent", fixture_name="teachingTransfer3DFixture")
            original = snapshot(page, "independent")
            dialog = open_transfer(page)
            assert dialog.locator('[data-preview-dimension="3d"]').count() == 1
            assert dialog.locator("canvas").count() == 1
            assert dialog.get_by_label("放置定位基准").input_value() == "center"
            dialog.get_by_role("button", name="转换预览俯视视角", exact=True).click()
            dialog.get_by_label("地图转换三维预览", exact=True).click()
            assert abs(float(dialog.get_by_label("放置 Z", exact=True).input_value())) < 1e-5
            dialog.get_by_label("放置 Z", exact=True).fill("1.5")
            dialog.get_by_role("button", name="转换预览3D视角", exact=True).click()
            dialog.get_by_role("button", name="移动组件", exact=True).click()
            dialog.get_by_role("button", name="聚焦转换组件", exact=True).click()
            before = values(dialog, "放置")
            drag_axis(page, dialog, "X")
            moved = values(dialog, "放置")
            assert abs(moved[0] - before[0]) > 0.01
            assert abs(moved[1] - before[1]) < 1e-5 and abs(moved[2] - before[2]) < 1e-5
            dialog.get_by_role("button", name="聚焦转换组件", exact=True).click()
            drag_axis(page, dialog, "Z", dx=0, dy=-35)
            assert abs(values(dialog, "放置")[2] - moved[2]) > 0.01
            dialog.get_by_role("button", name="旋转组件", exact=True).click()
            dialog.get_by_role("button", name="聚焦转换组件", exact=True).click()
            before = values(dialog, "放置")
            drag_axis(page, dialog, "Z", dx=25, dy=30)
            rotated = values(dialog, "放置")
            assert abs(rotated[5] - before[5]) > 1
            assert all(abs(rotated[i] - before[i]) < 1e-5 for i in range(3))
            page.screenshot(path="/tmp/transfer-3d-rotation.png", full_page=True)

            # Changing viewpoint and layer visibility must not move the component.
            canvas = dialog.get_by_label("地图转换三维预览", exact=True)
            image_before = canvas.screenshot()
            box = canvas.bounding_box()
            page.mouse.move(box["x"] + 50, box["y"] + 65)
            page.mouse.down()
            page.mouse.move(box["x"] + 120, box["y"] + 95, steps=8)
            page.mouse.up()
            assert canvas.screenshot() != image_before
            assert values(dialog, "放置") == rotated
            for view in ["俯视", "正视", "侧视", "3D"]:
                dialog.get_by_role("button", name=f"转换预览{view}视角", exact=True).click()
            dialog.get_by_role("checkbox", name="地图", exact=True).uncheck()
            dialog.get_by_role("checkbox", name="独立组件", exact=True).uncheck()
            dialog.get_by_role("checkbox", name="独立组件", exact=True).check()
            dialog.get_by_role("checkbox", name="地图", exact=True).check()
            assert values(dialog, "放置") == rotated

            # Rebase the numeric controls without moving the workpiece, then use
            # the unchanged robot anchor to verify the committed world pose.
            dialog.get_by_label("放置定位基准").select_option("robot")
            expected = values(dialog, "放置")
            dialog.get_by_role("button", name="放置并进入地图", exact=True).click()
            ready(page, "map")
            placed = snapshot(page, "map")["project"]["robot"]["origin"]
            assert all(abs(placed["position"][axis] - expected[i]) < 1e-5 for i, axis in enumerate(["x", "y", "z"]))
            assert all(abs(placed["rpy"][axis] - expected[i + 3]) < 1e-5 for i, axis in enumerate(["roll", "pitch", "yaw"]))
            assert snapshot(page, "independent")["positions"] == original["positions"]
            page.close()

            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("console", lambda message: shader_errors.append(message.text) if message.type == "error" and "THREE" in message.text else None)
            seed(page, ["map", "independent"], "map", fixture_name="teachingTransfer3DFixture")
            original = snapshot(page, "map")
            dialog = open_transfer(page)
            minimum = dialog.get_by_label("裁剪 Z 最小值")
            maximum = dialog.get_by_label("裁剪 Z 最大值")
            old_size = float(maximum.input_value()) - float(minimum.input_value())
            old_min = float(minimum.input_value())
            drag_axis(page, dialog, "Z", dx=0, dy=-30)
            assert abs(float(minimum.input_value()) - old_min) > 0.01
            assert abs(float(maximum.input_value()) - float(minimum.input_value()) - old_size) < 1e-5
            dialog.get_by_role("button", name="调整范围", exact=True).click()
            dialog.get_by_role("button", name="聚焦转换组件", exact=True).click()
            old_width = float(dialog.get_by_label("裁剪 X 最大值").input_value()) - float(dialog.get_by_label("裁剪 X 最小值").input_value())
            drag_axis(page, dialog, "X", dx=35, dy=20)
            width = float(dialog.get_by_label("裁剪 X 最大值").input_value()) - float(dialog.get_by_label("裁剪 X 最小值").input_value())
            assert abs(width - old_width) > 0.01
            for axis, limits in {"X": (8, 14), "Y": (17, 23), "Z": (-0.1, 3.4)}.items():
                dialog.get_by_label(f"裁剪 {axis} 最小值").fill(str(limits[0]))
                dialog.get_by_label(f"裁剪 {axis} 最大值").fill(str(limits[1]))
            # Align the origin to the crop center so the gizmo is centered on focus.
            dialog.get_by_label("对齐到已有位置").select_option("center")
            dialog.get_by_label("局部原点 Z", exact=True).fill("1.65")
            dialog.get_by_role("button", name="移动原点", exact=True).click()
            dialog.get_by_role("button", name="聚焦转换组件", exact=True).click()
            before = values(dialog, "局部原点")
            drag_axis(page, dialog, "X", dx=20, dy=15)
            assert abs(values(dialog, "局部原点")[0] - before[0]) > 0.01
            page.screenshot(path="/tmp/transfer-3d-crop.png", full_page=True)
            dialog.get_by_role("checkbox", name=re.compile("用本次提取")).check()
            dialog.get_by_role("button", name="提取并进入独立示教", exact=True).click()
            ready(page, "independent")
            assert 0 < snapshot(page, "independent")["pointCount"] < original["pointCount"]
            assert snapshot(page, "map")["positions"] == original["positions"]
            dialog = open_transfer(page)
            assert dialog.get_by_role("group", name="三维编辑工具").count() == 0
            assert dialog.get_by_role("checkbox", name="独立组件", exact=True).is_checked()
            dialog.get_by_role("button", name="作为新工位放置", exact=True).click()
            assert dialog.get_by_role("button", name="移动组件", exact=True).is_visible()
            dialog.get_by_role("button", name="回写原地图", exact=True).click()
            dialog.get_by_role("button", name="回写并进入地图", exact=True).click()
            ready(page, "map")
            assert snapshot(page, "map")["positions"] == original["positions"]
            assert not errors, errors
            assert not shader_errors, shader_errors
            print("3d_axis_translation_and_rotation=ok")
            print("3d_surface_pick_and_camera_isolation=ok")
            print("3d_crop_box_and_origin_editing=ok")
            print("hidden_robot_pose_and_writeback=ok")
            print("page_and_shader_errors=[]")
        finally:
            browser.close()


if __name__ == "__main__":
    run()
