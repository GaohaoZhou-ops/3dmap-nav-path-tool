import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:22095")
ROOT = Path(__file__).resolve().parents[1]
RAW_AXES = ["x", "y", "z", "rx", "ry", "rz"]
CONTROL_TO_RAW = {
    "x": "x",
    "y": "y",
    "z": "z",
    "roll": "rx",
    "pitch": "ry",
    "yaw": "rz",
}


def capture(raw_axis, sign):
    values = {axis: 0 for axis in RAW_AXES}
    values[raw_axis] = sign * 220
    return {
        "vector": values,
        "captureStrategy": "outbound-peak-envelope-v1",
        "dominantAxis": raw_axis,
        "activeAxes": [raw_axis],
    }


PROFILE = {
    "version": 4,
    "semantics": "ros-single-axis-button-cycle-v2",
    "calibrationModel": "coupled-6d-ridge-v1",
    "captureStrategy": "outbound-peak-envelope-v1",
    "buttonCalibration": "physical-mask-xyz-rpy-v1",
    "model": "3DConnexion SpaceMouse Wireless Bluetooth Edition",
    "device": {
        "vendorId": 0x256F,
        "productId": 0xC63A,
        "productName": "SpaceMouse Wireless BT",
    },
    "mappings": {
        control_axis: {
            "positive": capture(raw_axis, 1),
            "negative": capture(raw_axis, -1),
        }
        for control_axis, raw_axis in CONTROL_TO_RAW.items()
    },
    "responseCurve": 1.1,
    "deadzoneRatio": 0.06,
    "buttons": {"xyz": 1, "rpy": 2},
    "calibratedAt": "2026-09-14T00:00:00.000Z",
}


MOCK_WEBHID = r"""
(() => {
  class MockSpaceMouseDevice extends EventTarget {
    constructor() {
      super();
      this.vendorId = 0x256f;
      this.productId = 0xc63a;
      this.productName = 'SpaceMouse Wireless BT';
      this.collections = [{ usagePage: 0x01, usage: 0x08 }];
      this.opened = false;
    }
    async open() { this.opened = true; }
    async close() { this.opened = false; }
    emit(reportId, values) {
      const bytes = new Uint8Array(values.length * 2);
      const view = new DataView(bytes.buffer);
      values.forEach((value, index) => view.setInt16(index * 2, value, true));
      const event = new Event('inputreport');
      Object.defineProperties(event, {
        reportId: { value: reportId },
        data: { value: view },
      });
      this.dispatchEvent(event);
    }
    emitButtons(mask) {
      const event = new Event('inputreport');
      Object.defineProperties(event, {
        reportId: { value: 3 },
        data: { value: new DataView(Uint8Array.from([mask]).buffer) },
      });
      this.dispatchEvent(event);
    }
  }

  class MockHID extends EventTarget {
    constructor() {
      super();
      this.device = new MockSpaceMouseDevice();
    }
    async getDevices() {
      return localStorage.getItem('__atlas_mock_hid_granted') === 'true'
        ? [this.device]
        : [];
    }
    async requestDevice() {
      localStorage.setItem('__atlas_mock_hid_granted', 'true');
      window.__spaceMouseRequestCount = Number(window.__spaceMouseRequestCount || 0) + 1;
      return [this.device];
    }
  }

  const hid = new MockHID();
  Object.defineProperty(navigator, 'hid', {
    configurable: true,
    enumerable: true,
    value: hid,
  });
  window.__spaceMouseMock = hid.device;
  window.__spaceMouseRequestCount = 0;
})();
"""


def emit_motion(page, report_id, values, duration_ms=300):
    page.evaluate(
        """async ({ reportId, values, durationMs }) => {
          const deadline = performance.now() + durationMs;
          while (performance.now() < deadline) {
            window.__spaceMouseMock.emit(reportId, values);
            await new Promise((resolve) => setTimeout(resolve, 28));
          }
          window.__spaceMouseMock.emit(reportId, [0, 0, 0]);
        }""",
        {"reportId": report_id, "values": values, "durationMs": duration_ms},
    )


def press_button(page, mask):
    page.evaluate(
        """mask => {
          window.__spaceMouseMock.emitButtons(mask);
          window.__spaceMouseMock.emitButtons(0);
        }""",
        mask,
    )


def vector_attribute(locator, name):
    return tuple(float(value) for value in locator.get_attribute(name).split(","))


def vector_distance(left, right):
    return sum((a - b) ** 2 for a, b in zip(left, right)) ** 0.5


def run():
    errors = []
    console_errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1600, "height": 960})
        context.add_init_script(MOCK_WEBHID)
        context.add_init_script(
            f"""
            localStorage.setItem(
              'atlas-route-studio:spacemouse-wireless-bt-profile-v4',
              JSON.stringify({json.dumps(PROFILE)})
            );
            """
        )
        page = context.new_page()
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
        control = page.locator(".spacemouse-control")
        page.wait_for_function(
            "document.querySelector('.spacemouse-control')?.dataset.spacemouseState === 'idle'"
        )
        assert control.get_attribute("data-spacemouse-state") == "idle"
        assert control.get_attribute("data-spacemouse-calibrated") == "true"
        assert control.get_attribute("data-spacemouse-selected-axis") == "x"

        page.get_by_role("tab", name="虚拟示教与相机").click()
        assert page.get_by_label("全关节控制浮动窗口", exact=True).count() == 0
        page.locator('input[type="file"][accept=".ply"]').set_input_files(
            str(ROOT / "tests/fixtures/rotation-map.ply")
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.get_by_role("button", name="加载机器人", exact=True).click()
        page.get_by_role("option", name="加载机器人 botx_abx_zivid_m70").click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'"
        )
        page.get_by_role("button", name="新建示教任务", exact=True).click()
        page.get_by_role("dialog", name="新建示教任务").get_by_role(
            "button", name="创建任务", exact=True
        ).click()
        page.wait_for_function(
            "document.querySelector('[aria-label=\"虚拟示教\"]')?.dataset.teachingTaskCount === '1'"
        )
        page.wait_for_function(
            "document.querySelector('[aria-label=\"Zivid 2 M70 相机视图\"]')?.dataset.cameraTeachingMode === 'active'"
        )

        main_canvas = page.locator(".three-canvas")
        panel = page.get_by_label("Zivid 2 M70 相机视图", exact=True)
        assert page.get_by_label("相机视角反算示教", exact=True).count() == 0
        panel.get_by_role("button", name="放大 Zivid 相机视图").click()
        dialog = page.get_by_role("dialog", name="Zivid 2 M70 相机大图")
        dialog.wait_for()
        panel = dialog.get_by_label("Zivid 2 M70 相机视图", exact=True)
        camera_teach = dialog.get_by_label("相机视角反算示教", exact=True)
        camera_teach.wait_for()
        assert camera_teach.get_attribute("data-camera-ready") == "true"
        camera_canvas = panel.get_by_label("Zivid 2 M70 仿真相机画面", exact=True)
        toggle = panel.locator(".zivid-camera-spacemouse-toggle")
        assert toggle.is_visible()
        page.wait_for_function(
            "document.querySelector('.zivid-camera-panel.is-expanded')?.dataset.spacemouseConnectFromCamera === 'available'"
        )
        assert toggle.is_enabled()
        assert toggle.get_attribute("aria-pressed") == "false"
        assert toggle.get_attribute("aria-label") == "连接 SpaceMouse 并启用相机视角控制"
        assert panel.get_attribute("data-spacemouse-ready") == "false"
        assert page.evaluate("window.__spaceMouseRequestCount") == 0
        assert panel.get_attribute("data-spacemouse-control-model") == "optical-frame-ik"
        assert panel.get_attribute("data-spacemouse-zoom-policy") == "mouse-only"

        panel.get_by_role("button", name="放大相机画面").click()
        page.wait_for_function(
            "Number(document.querySelector('.zivid-camera-panel.is-expanded')?.dataset.zoom) > 1"
        )
        zoom_before = float(panel.get_attribute("data-zoom"))
        left_pose_before = vector_attribute(main_canvas, "data-zivid-left-optical-position")

        toggle.click()
        page.wait_for_function(
            "document.querySelector('.spacemouse-control')?.dataset.spacemouseState === 'connected'"
        )
        page.wait_for_function(
            "document.querySelector('.zivid-camera-panel.is-expanded')?.dataset.spacemouseReady === 'true'"
        )
        page.wait_for_function(
            "document.querySelector('.zivid-camera-panel.is-expanded')?.dataset.spacemouseViewEnabled === 'true'"
        )
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.spacemouseControlTarget === 'zivid-camera'"
        )
        assert panel.get_by_role(
            "button", name="关闭 SpaceMouse 相机视角控制"
        ).get_attribute("aria-pressed") == "true"
        assert page.evaluate("window.__spaceMouseRequestCount") == 1
        assert panel.locator(".zivid-camera-spacemouse-route").count() == 0
        axis_indicator = panel.locator(".zivid-camera-spacemouse-axis")
        assert axis_indicator.is_visible()
        assert axis_indicator.get_attribute("data-axis") == "x"
        assert axis_indicator.get_attribute("data-axis-code") == "X"
        assert "XYZ" in axis_indicator.inner_text()
        assert "X" in axis_indicator.inner_text()

        emit_motion(page, 1, [190, 0, 0])
        page.wait_for_function(
            """() => {
              const canvas = document.querySelector('.three-canvas');
              return canvas?.dataset.cameraTeachingSource === 'spacemouse'
                && canvas?.dataset.cameraTeachingAction === 'near'
                && canvas?.dataset.cameraTeachingState === 'settled';
            }"""
        )
        left_pose_after = vector_attribute(main_canvas, "data-zivid-left-optical-position")
        assert vector_distance(left_pose_before, left_pose_after) > 0.002
        assert int(camera_canvas.get_attribute("data-spacemouse-input-count")) > 0
        assert camera_canvas.get_attribute("data-spacemouse-control-model") == "optical-frame-ik"
        assert camera_canvas.get_attribute("data-spacemouse-zoom-policy") == "mouse-only"
        assert float(panel.get_attribute("data-zoom")) == zoom_before
        hud = panel.get_by_label("SpaceMouse 相机控制轴")
        assert hud.get_attribute("data-axis") == "x"
        assert "前进" in hud.inner_text()

        previous_revision = int(main_canvas.get_attribute("data-camera-teaching-revision"))
        left_quaternion_before = vector_attribute(
            main_canvas, "data-zivid-left-optical-quaternion"
        )
        press_button(page, 2)
        page.wait_for_function(
            "document.querySelector('.spacemouse-control')?.dataset.spacemouseSelectedAxis === 'yaw'"
        )
        emit_motion(page, 2, [0, 0, 190])
        page.wait_for_function(
            """previous => {
              const canvas = document.querySelector('.three-canvas');
              return Number(canvas?.dataset.cameraTeachingRevision) > previous
                && canvas?.dataset.cameraTeachingSource === 'spacemouse'
                && canvas?.dataset.cameraTeachingAction === 'yaw-left'
                && canvas?.dataset.cameraTeachingState === 'settled';
            }""",
            arg=previous_revision,
        )
        assert hud.get_attribute("data-axis") == "yaw"
        assert "左偏航" in hud.inner_text()
        page.wait_for_function(
            """() => document.querySelector('.zivid-camera-spacemouse-axis')
              ?.dataset.axis === 'yaw'"""
        )
        assert axis_indicator.get_attribute("data-axis-code") == "YAW"
        assert "RPY" in axis_indicator.inner_text()
        assert "YAW" in axis_indicator.inner_text()
        left_quaternion_after = vector_attribute(
            main_canvas, "data-zivid-left-optical-quaternion"
        )
        assert vector_distance(left_quaternion_before, left_quaternion_after) > 0.002
        assert float(panel.get_attribute("data-zoom")) == zoom_before
        page.evaluate("window.__spaceMouseMock.emit(2, [0, 0, 190])")
        page.wait_for_function(
            """() => document.querySelector('.zivid-camera-spacemouse-hud')
              ?.dataset.motionState === 'active'"""
        )
        assert hud.is_visible()
        dialog.screenshot(path="/tmp/atlas-zivid-spacemouse-camera.png")
        page.evaluate("window.__spaceMouseMock.emit(2, [0, 0, 0])")

        camera_input_count = int(camera_canvas.get_attribute("data-spacemouse-input-count"))
        main_input_before = int(main_canvas.get_attribute("data-spacemouse-input-count") or 0)
        panel.get_by_role("button", name="关闭 Zivid 相机大图").click()
        dialog.wait_for(state="detached")
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.spacemouseControlTarget === 'viewport'"
        )
        press_button(page, 1)
        page.wait_for_function(
            "document.querySelector('.spacemouse-control')?.dataset.spacemouseSelectedAxis === 'x'"
        )
        emit_motion(page, 1, [190, 0, 0], duration_ms=180)
        page.wait_for_function(
            """previous => Number(
              document.querySelector('.three-canvas')?.dataset.spacemouseInputCount || 0
            ) > previous""",
            arg=main_input_before,
        )

        print("camera_spacemouse_inputs=", camera_input_count)
        print("restored_viewport_input_count=", main_canvas.get_attribute("data-spacemouse-input-count"))
        print("page_errors=", errors)
        print("console_errors=", console_errors)
        assert not errors, errors
        assert not console_errors, console_errors
        browser.close()


if __name__ == "__main__":
    run()
