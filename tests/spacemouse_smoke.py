import json
import math
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
ROOT = Path(__file__).resolve().parents[1]
COUPLED_MOTIONS = {
    "x": [210, 46, -31, 28, 17, -14],
    "y": [35, 225, 42, -19, 31, 16],
    "z": [-28, 39, 235, 15, -24, 33],
    "roll": [24, -17, 21, 205, 48, -36],
    "pitch": [-18, 29, -26, 38, 218, 44],
    "yaw": [27, -22, 32, -31, 41, 228],
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
    emitAxis(axis, value) {
      const translation = { x: 0, y: 0, z: 0 };
      const rotation = { rx: 0, ry: 0, rz: 0 };
      if (axis in translation) {
        translation[axis] = value;
        this.emit(1, [translation.x, translation.y, translation.z]);
      } else {
        rotation[axis] = value;
        this.emit(2, [rotation.rx, rotation.ry, rotation.rz]);
      }
    }
    emitVector(values) {
      this.emit(1, values);
    }
    emitSplitVector(values) {
      this.emit(1, values.slice(0, 3));
      this.emit(2, values.slice(3, 6));
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
      return localStorage.getItem('__atlas_mock_hid_granted') ? [this.device] : [];
    }
    async requestDevice(options) {
      window.__spaceMouseRequestFilters = options.filters;
      localStorage.setItem('__atlas_mock_hid_granted', 'true');
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
})();
"""


def read_camera(canvas):
    return tuple(
        float(canvas.get_attribute(f"data-{name}"))
        for name in (
            "camera-x",
            "camera-y",
            "camera-z",
            "target-x",
            "target-y",
            "target-z",
            "camera-up-x",
            "camera-up-y",
            "camera-up-z",
        )
    )


def normalize3(vector):
    magnitude = math.sqrt(sum(value * value for value in vector))
    assert magnitude > 1e-12
    return tuple(value / magnitude for value in vector)


def dot3(left, right):
    return sum(a * b for a, b in zip(left, right))


def cross3(left, right):
    return (
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    )


def emit_axis(page, axis, value):
    page.evaluate(
        "([axis, value]) => window.__spaceMouseMock.emitAxis(axis, value)",
        [axis, value],
    )


def emit_vector(page, vector):
    page.evaluate(
        "values => window.__spaceMouseMock.emitVector(values)",
        [round(value) for value in vector],
    )


def press_control_button(page, mask):
    page.evaluate("mask => window.__spaceMouseMock.emitButtons(mask)", mask)
    page.evaluate("window.__spaceMouseMock.emitButtons(0)")


def double_press_control_button(page, mask, interval_ms=150):
    page.evaluate(
        """async ([mask, intervalMs]) => {
          const press = () => {
            window.__spaceMouseMock.emitButtons(mask);
            window.__spaceMouseMock.emitButtons(0);
          };
          press();
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          press();
        }""",
        [mask, interval_ms],
    )


def emit_split_vector(page, vector):
    page.evaluate(
        "values => window.__spaceMouseMock.emitSplitVector(values)",
        [round(value) for value in vector],
    )


def scaled_vector(vector, scale):
    return [value * scale for value in vector]


def blended_vector(*weighted_vectors):
    return [
        sum(vector[index] * weight for vector, weight in weighted_vectors)
        for index in range(6)
    ]


def sample_motion(page, vector):
    for scale in (0.48, 0.72, 1.0, 1.0, 0.84):
        emit_split_vector(page, scaled_vector(vector, scale))
        # Leave at least one full render frame so split translation/rotation
        # packets are coalesced into one complete six-axis calibration sample.
        page.wait_for_timeout(28)


def hold_vector(page, vector, duration_ms=240, interval_ms=30):
    for _ in range(max(1, duration_ms // interval_ms)):
        emit_vector(page, vector)
        page.wait_for_timeout(interval_ms)
    emit_vector(page, [0, 0, 0, 0, 0, 0])


def run():
    errors = []
    with sync_playwright() as playwright:
      browser = playwright.chromium.launch(headless=True)
      context = browser.new_context(viewport={"width": 1600, "height": 960})
      context.add_init_script(MOCK_WEBHID)
      page = context.new_page()
      page.set_default_timeout(30_000)
      page.on("pageerror", lambda error: errors.append(str(error)))

      page.goto(BASE_URL, wait_until="networkidle")
      page.locator('[data-session-state="ready"]').wait_for()
      control = page.locator(".spacemouse-control")
      trigger = page.get_by_role("button", name="检测3D鼠标")
      assert control.get_attribute("data-spacemouse-state") == "idle"
      assert control.get_attribute("data-spacemouse-calibrated") == "false"

      trigger.click()
      page.wait_for_function(
          "document.querySelector('.spacemouse-control')?.dataset.spacemouseState === 'connected'"
      )
      assert control.get_attribute("data-spacemouse-product-id") == "0xc63a"
      request_filters = page.evaluate("window.__spaceMouseRequestFilters")
      assert {"vendorId": 0x256F, "productId": 0xC63A} in request_filters

      calibration = page.get_by_role("dialog", name="SpaceMouse 首次校准")
      calibration.wait_for()
      assert calibration.get_attribute("data-calibration-stage") == "intro"
      assert calibration.get_attribute("data-auto-advance-ms") == "500"
      page.wait_for_timeout(260)
      page.screenshot(path="/tmp/atlas-spacemouse-calibration-intro.png", full_page=True)
      page.get_by_role("button", name="开始 14 项标定").click()
      page.wait_for_function(
          "document.querySelector('.spacemouse-calibration')?.dataset.calibrationStage === 'armed'"
      )
      previous_step = page.get_by_role("button", name="返回上一步")
      assert previous_step.is_disabled()

      # Learn the physical XYZ/RPY buttons instead of assuming HID bit masks.
      assert calibration.locator(".spacemouse-calibration__target strong").inner_text() == (
          "XYZ 轴切换键"
      )
      button_advance_started = page.evaluate("performance.now()")
      press_control_button(page, 1)
      page.wait_for_function(
          "document.querySelector('.spacemouse-calibration')?.dataset.calibrationStage === 'captured'"
      )
      assert "XYZ SWITCH · 0x01" in calibration.inner_text()
      page.wait_for_function(
          """document.querySelector('.spacemouse-calibration')?.dataset.calibrationStep === '2'
            && document.querySelector('.spacemouse-calibration')?.dataset.calibrationStage === 'armed'"""
      )
      button_advance_elapsed = page.evaluate("performance.now()") - button_advance_started
      assert 430 <= button_advance_elapsed < 1000
      assert previous_step.is_enabled()

      # Returning from step two re-arms the prior button capture and cancels
      # the active step without clearing the rest of the calibration draft.
      previous_step.click()
      page.wait_for_function(
          """document.querySelector('.spacemouse-calibration')?.dataset.calibrationStep === '1'
            && document.querySelector('.spacemouse-calibration')?.dataset.calibrationStage === 'armed'"""
      )
      assert previous_step.is_disabled()
      press_control_button(page, 1)
      page.wait_for_function(
          """document.querySelector('.spacemouse-calibration')?.dataset.calibrationStep === '2'
            && document.querySelector('.spacemouse-calibration')?.dataset.calibrationStage === 'armed'"""
      )
      assert calibration.locator(".spacemouse-calibration__target strong").inner_text() == (
          "RPY 轴切换键"
      )
      press_control_button(page, 2)
      page.wait_for_function(
          "document.querySelector('.spacemouse-calibration')?.dataset.calibrationStage === 'captured'"
      )
      assert "RPY SWITCH · 0x02" in calibration.inner_text()
      page.wait_for_function(
          """document.querySelector('.spacemouse-calibration')?.dataset.calibrationStep === '3'
            && document.querySelector('.spacemouse-calibration')?.dataset.calibrationStage === 'armed'"""
      )

      captures = [
          (COUPLED_MOTIONS["x"], "+X", "前进"),
          (scaled_vector(COUPLED_MOTIONS["x"], -1.04), "−X", "后退"),
          (COUPLED_MOTIONS["y"], "+Y", "向左"),
          (scaled_vector(COUPLED_MOTIONS["y"], -0.96), "−Y", "向右"),
          (COUPLED_MOTIONS["z"], "+Z", "向上"),
          (scaled_vector(COUPLED_MOTIONS["z"], -1.03), "−Z", "向下"),
          (COUPLED_MOTIONS["roll"], "+R", "左翻滚"),
          (scaled_vector(COUPLED_MOTIONS["roll"], -1.05), "−R", "右翻滚"),
          (COUPLED_MOTIONS["pitch"], "+P", "前倾"),
          (scaled_vector(COUPLED_MOTIONS["pitch"], -0.97), "−P", "后仰"),
          (COUPLED_MOTIONS["yaw"], "+YAW", "左偏航"),
          (scaled_vector(COUPLED_MOTIONS["yaw"], -1.02), "−YAW", "右偏航"),
      ]
      for index, (motion, code, title) in enumerate(captures):
          assert calibration.get_attribute("data-calibration-step") == str(index + 3)
          assert calibration.get_attribute("data-calibration-stage") == "armed"
          target = calibration.locator(".spacemouse-calibration__target")
          assert target.locator(":scope > span").inner_text() == code
          assert target.locator("strong").inner_text() == title
          if index == 0:
              page.wait_for_timeout(180)
              page.screenshot(path="/tmp/atlas-spacemouse-calibration-step.png", full_page=True)
          sample_motion(page, motion)
          page.wait_for_function(
              "document.querySelector('.spacemouse-calibration')?.dataset.calibrationStage === 'sampling'"
          )
          auto_advance_started = page.evaluate("performance.now()")
          if index == 0:
              capture_state = calibration.locator(".spacemouse-capture-state")
              assert capture_state.get_attribute("data-capture-strategy") == (
                  "outbound-peak-envelope-v1"
              )

              # A realistic release crosses center with a strong, unrelated
              # multi-axis spring-back. The peak envelope must freeze before
              # this vector and exclude it from the semantic fingerprint.
              rebound = scaled_vector(COUPLED_MOTIONS["yaw"], -0.92)
              emit_split_vector(page, rebound)
              page.wait_for_function(
                  "document.querySelector('.spacemouse-calibration')?.dataset.calibrationStage === 'returning'"
              )
              assert int(capture_state.get_attribute("data-peak-sample-count")) >= 1
              assert int(capture_state.get_attribute("data-release-samples-ignored")) >= 1
              assert "PEAK LOCKED" in capture_state.inner_text()

              # Crossing center starts a settle window before the frozen peak
              # is committed; the prior rebound remains excluded.
              emit_vector(page, [0, 0, 0, 0, 0, 0])
              page.wait_for_function(
                  """['settling', 'captured'].includes(
                    document.querySelector('.spacemouse-calibration')?.dataset.calibrationStage
                  )"""
              )
          else:
              emit_vector(page, [0, 0, 0, 0, 0, 0])
          page.wait_for_function(
              "document.querySelector('.spacemouse-calibration')?.dataset.calibrationStage === 'captured'"
          )
          if index == 0:
              assert int(capture_state.get_attribute("data-active-axis-count")) >= 2
              assert "融合" in capture_state.inner_text()
              page.screenshot(path="/tmp/atlas-spacemouse-auto-advance.png", full_page=True)
          if index == len(captures) - 1:
              page.wait_for_function(
                  "document.querySelector('.spacemouse-calibration')?.dataset.calibrationStage === 'complete'"
              )
          else:
              page.wait_for_function(
                  f"""document.querySelector('.spacemouse-calibration')?.dataset.calibrationStep === '{index + 4}'
                    && document.querySelector('.spacemouse-calibration')?.dataset.calibrationStage === 'armed'"""
              )
          if index == 0:
              auto_advance_elapsed = page.evaluate("performance.now()") - auto_advance_started
              assert auto_advance_elapsed >= 430

      page.wait_for_function(
          "document.querySelector('.spacemouse-calibration')?.dataset.calibrationStage === 'complete'"
      )
      stored_profile = json.loads(page.evaluate(
          "localStorage.getItem('atlas-route-studio:spacemouse-wireless-bt-profile-v4')"
      ))
      assert stored_profile["version"] == 4
      assert stored_profile["semantics"] == "ros-single-axis-button-cycle-v2"
      assert stored_profile["calibrationModel"] == "coupled-6d-ridge-v1"
      assert stored_profile["buttonCalibration"] == "physical-mask-xyz-rpy-v1"
      assert stored_profile["buttons"] == {"xyz": 1, "rpy": 2}
      assert stored_profile["captureStrategy"] == "outbound-peak-envelope-v1"
      assert stored_profile["model"].endswith("Bluetooth Edition")
      assert len(stored_profile["mappings"]) == 6
      assert len(stored_profile["decoder"]) == 6
      assert stored_profile["activeAxisAverage"] >= 2
      assert stored_profile["mappings"]["x"]["positive"]["captureStrategy"] == (
          "outbound-peak-envelope-v1"
      )
      assert stored_profile["mappings"]["x"]["positive"]["ignoredReleaseSamples"] >= 1
      assert len(stored_profile["mappings"]["x"]["positive"]["activeAxes"]) >= 2
      for control_index, control_axis in enumerate(
          ["x", "y", "z", "roll", "pitch", "yaw"]
      ):
          normalized_raw = [
              COUPLED_MOTIONS[control_axis][index] / stored_profile["rawScale"][index]
              for index in range(6)
          ]
          decoded = [
              sum(weight * normalized_raw[index] for index, weight in enumerate(row))
              for row in stored_profile["decoder"]
          ]
          leakage = max(
              abs(value) for index, value in enumerate(decoded) if index != control_index
          )
          assert decoded[control_index] > 0.85
          assert leakage < 0.08
      page.get_by_role("button", name="进入 3D 场景").click()
      assert control.get_attribute("data-spacemouse-calibrated") == "true"
      assert control.get_attribute("data-spacemouse-calibration-model") == "coupled-6d-ridge-v1"

      # Real hardware normally sends T and R as two reports in the same paint
      # frame. After the calibration state closes, the live panel must retain
      # the second packet and expose one complete TX..RZ snapshot.
      live_axes = control.locator(".spacemouse-live-axes")
      live_axes.wait_for()
      split_live_values = [147, -93, 61, 118, -72, 204]
      emit_split_vector(page, split_live_values)
      page.wait_for_function(
          """expected => expected.every(([axis, value]) =>
            document.querySelector(`.spacemouse-live-axes [data-axis="${axis}"]`)
              ?.dataset.value === String(value)
          )""",
          arg=list(zip(["x", "y", "z", "rx", "ry", "rz"], split_live_values)),
      )
      assert control.get_attribute("data-spacemouse-signal") == "active"
      emit_split_vector(page, [0, 0, 0, 0, 0, 0])
      page.wait_for_function(
          """() => [...document.querySelectorAll('.spacemouse-live-axes [data-axis]')]
            .every((item) => item.dataset.value === '0')"""
      )
      assert control.get_attribute("data-spacemouse-signal") == "idle"

      page.locator('input[type="file"][accept=".ply"]').set_input_files(
          str(ROOT / "tests/fixtures/rotation-map.ply")
      )
      canvas = page.locator(".three-canvas")
      canvas.wait_for()
      page.locator(".loading-curtain").wait_for(state="hidden")
      assert canvas.get_attribute("data-spacemouse-control-target") == "viewport"
      assert canvas.get_attribute("data-spacemouse-coexistence") == "parallel-input"
      assert canvas.get_attribute("data-spacemouse-zoom-policy") == "mouse-only"
      assert int(canvas.get_attribute("data-spacemouse-wheel-arbitration-ms")) == 48
      assert canvas.get_attribute("data-spacemouse-x-policy") == (
          "camera-heading-translation-no-zoom"
      )
      assert canvas.get_attribute("data-spacemouse-y-polarity") == "+y:left,-y:right"
      assert canvas.get_attribute("data-spacemouse-z-polarity") == "+z:up,-z:down"
      assert canvas.get_attribute("data-spacemouse-motion-filter") == (
          "adaptive-frame-low-pass"
      )
      assert canvas.get_attribute("data-spacemouse-axis-policy") == "button-selected-only"
      assert canvas.get_attribute("data-spacemouse-selected-axis") == "x"
      assert int(canvas.get_attribute("data-spacemouse-axis-hud-hold-ms")) == 1000
      assert canvas.get_attribute("data-spacemouse-applied-axis-count") == "0"
      assert control.get_attribute("data-spacemouse-control-enabled") == "true"
      assert canvas.get_attribute("data-spacemouse-control-enabled") == "true"
      assert control.get_attribute("data-spacemouse-button-gesture") == (
          "left-cycle-xyz,right-cycle-rpy,same-button-double-pause"
      )
      assert control.get_attribute("data-spacemouse-xyz-button") == "0x01"
      assert control.get_attribute("data-spacemouse-rpy-button") == "0x02"
      assert control.get_attribute("data-spacemouse-pointer-motion-guard-ms") == "320"
      assert control.get_attribute("data-spacemouse-pointer-button-guard-ms") == "560"
      assert control.get_attribute("data-spacemouse-pointer-activity-threshold") == "8"
      assert control.get_attribute("data-spacemouse-pointer-move-policy") == (
          "native-unintercepted"
      )
      assert control.get_attribute("data-spacemouse-pointer-guard-timer") == (
          "deadline-coalesced"
      )
      assert control.get_attribute("data-spacemouse-pointer-lock-strategy") == (
          "gesture-primed-transient"
      )
      assert control.get_attribute("data-spacemouse-pointer-guard") == "idle"
      assert float(canvas.get_attribute("data-spacemouse-filter-attack-ms")) < 50
      assert float(canvas.get_attribute("data-spacemouse-filter-release-ms")) < 80

      # Some 3DxWare configurations also expose cap motion and the two device
      # keys as a conventional system mouse. A HID button report must arm the
      # page-level firewall before that mapped click can activate another UI.
      protected_toggle = page.get_by_role("button", name="隐藏3D路径点")
      protected_toggle_box = protected_toggle.bounding_box()
      assert protected_toggle_box is not None
      page.evaluate("window.__spaceMouseMock.emitButtons(2)")
      page.mouse.click(
          protected_toggle_box["x"] + protected_toggle_box["width"] / 2,
          protected_toggle_box["y"] + protected_toggle_box["height"] / 2,
      )
      page.evaluate("window.__spaceMouseMock.emitButtons(0)")
      assert page.get_by_role("button", name="隐藏3D路径点").get_attribute(
          "aria-pressed"
      ) == "true"
      assert control.get_attribute("data-spacemouse-pointer-guard") == "active"
      assert control.get_attribute("data-spacemouse-pointer-guard-reason") == (
          "physical-button"
      )
      assert int(control.get_attribute("data-spacemouse-suppressed-pointer-events")) >= 1
      assert page.locator("html").evaluate(
          "element => element.classList.contains('is-spacemouse-pointer-guarded')"
      )
      page.wait_for_function(
          """() => ['locked', 'unavailable'].includes(
            document.querySelector('.spacemouse-control')?.dataset.spacemousePointerLock
          )"""
      )
      pointer_lock_state = control.get_attribute("data-spacemouse-pointer-lock")
      if pointer_lock_state == "locked":
          assert page.evaluate(
              "document.pointerLockElement === document.documentElement"
          )
      page.wait_for_function(
          "document.querySelector('.spacemouse-control')?.dataset.spacemousePointerGuard === 'idle'"
      )
      assert page.evaluate("document.pointerLockElement === null")
      page.get_by_role("button", name="隐藏3D路径点").click()
      assert page.get_by_role("button", name="显示3D路径点").is_visible()
      page.get_by_role("button", name="显示3D路径点").click()
      assert page.get_by_role("button", name="隐藏3D路径点").is_visible()

      # Cap motion uses a shorter guard and automatically hands ordinary mouse
      # interaction back after the final zero report.
      press_control_button(page, 1)
      page.wait_for_function(
          "document.querySelector('.spacemouse-control')?.dataset.spacemouseMode === 'xyz'"
      )
      page.wait_for_function(
          "document.querySelector('.spacemouse-control')?.dataset.spacemousePointerGuard === 'idle'"
      )
      suppressed_before_motion = int(
          control.get_attribute("data-spacemouse-suppressed-pointer-events")
      )
      emit_vector(page, scaled_vector(COUPLED_MOTIONS["x"], 0.72))
      page.evaluate(
          "document.querySelector('[aria-label=\"隐藏3D路径点\"]').click()"
      )
      emit_vector(page, [0, 0, 0, 0, 0, 0])
      assert page.get_by_role("button", name="隐藏3D路径点").is_visible()
      assert control.get_attribute("data-spacemouse-pointer-guard-reason") == "cap-motion"
      assert int(control.get_attribute("data-spacemouse-suppressed-pointer-events")) > (
          suppressed_before_motion
      )
      page.wait_for_function(
          "document.querySelector('.spacemouse-control')?.dataset.spacemousePointerGuard === 'idle'"
      )

      # A same-side double press pauses viewport output without disconnecting
      # the device or profile. Physical cap motion while paused must be inert.
      double_press_control_button(page, 2)
      page.wait_for_function(
          "document.querySelector('.spacemouse-control')?.dataset.spacemouseControlEnabled === 'false'"
      )
      page.wait_for_function(
          "document.querySelector('.three-canvas')?.dataset.spacemouseControlEnabled === 'false'"
      )
      assert control.get_attribute("data-spacemouse-state") == "connected"
      assert control.get_attribute("data-spacemouse-calibrated") == "true"
      assert canvas.get_attribute("data-spacemouse-motion-state") == "idle"
      assert canvas.get_attribute("data-spacemouse-applied-axis-count") == "0"
      paused_panel = page.get_by_role("dialog", name="3D鼠标控制器")
      if not paused_panel.is_visible():
          page.wait_for_function(
              "document.querySelector('.spacemouse-control')?.dataset.spacemousePointerGuard === 'idle'"
          )
          trigger.click()
          paused_panel.wait_for()
      assert "SpaceMouse 控制已暂停" in paused_panel.inner_text()
      assert "单击任意实体键立即恢复" in paused_panel.inner_text()
      page.screenshot(path="/tmp/atlas-spacemouse-paused.png", full_page=True)
      paused_view_before = read_camera(canvas)
      paused_input_count = int(canvas.get_attribute("data-spacemouse-input-count"))
      hold_vector(page, scaled_vector(COUPLED_MOTIONS["yaw"], 0.9))
      page.wait_for_timeout(100)
      assert read_camera(canvas) == paused_view_before
      assert int(canvas.get_attribute("data-spacemouse-input-count")) == paused_input_count
      assert canvas.get_attribute("data-spacemouse-applied-axis-count") == "0"

      # One press resumes immediately in that button's mode. From this point
      # the coupled raw signature is decoded back to yaw normally.
      press_control_button(page, 2)
      page.wait_for_function(
          "document.querySelector('.spacemouse-control')?.dataset.spacemouseControlEnabled === 'true'"
      )
      page.wait_for_function(
          "document.querySelector('.spacemouse-control')?.dataset.spacemouseMode === 'rpy'"
      )
      page.wait_for_function(
          "document.querySelector('.three-canvas')?.dataset.spacemouseControlEnabled === 'true'"
      )
      assert canvas.get_attribute("data-spacemouse-control-enabled") == "true"

      # Deliberately send compound yaw + roll gestures. The right button has
      # selected YAW, so even a much stronger decoded roll signal must remain
      # gated off instead of flipping the whole view unexpectedly.
      axis_hud = page.locator(".spacemouse-axis-hud")
      yaw_dominant_mix = blended_vector(
          (COUPLED_MOTIONS["yaw"], 0.86),
          (COUPLED_MOTIONS["roll"], 0.48),
      )
      for _ in range(3):
          emit_vector(page, yaw_dominant_mix)
          page.wait_for_timeout(30)
      page.wait_for_function(
          "document.querySelector('.three-canvas')?.dataset.spacemouseDominantAxis === 'yaw'"
      )
      assert canvas.get_attribute("data-spacemouse-applied-axis-count") == "1"
      assert abs(float(canvas.get_attribute("data-spacemouse-target-yaw"))) > 0.1
      assert float(canvas.get_attribute("data-spacemouse-target-roll")) == 0
      assert float(canvas.get_attribute("data-spacemouse-filtered-roll")) == 0
      assert canvas.get_attribute("data-spacemouse-last-motion") == "yaw"
      assert canvas.get_attribute("data-spacemouse-selected-axis") == "yaw"
      page.evaluate(
          """values => {
            clearInterval(window.__spaceMouseHudPump);
            window.__spaceMouseHudPump = setInterval(
              () => window.__spaceMouseMock.emitVector(values),
              24
            );
          }""",
          [round(value) for value in yaw_dominant_mix],
      )
      page.wait_for_function(
          "document.querySelector('.spacemouse-axis-hud')?.dataset.state === 'active'"
      )
      assert axis_hud.get_attribute("data-axis") == "yaw"
      assert "YAW" in axis_hud.inner_text()
      assert "左偏航 / 右偏航" in axis_hud.inner_text()
      page.screenshot(path="/tmp/atlas-spacemouse-axis-hud.png", full_page=True)
      page.evaluate("clearInterval(window.__spaceMouseHudPump)")

      roll_dominant_mix = blended_vector(
          (COUPLED_MOTIONS["yaw"], 0.48),
          (COUPLED_MOTIONS["roll"], 0.86),
      )
      for _ in range(3):
          emit_vector(page, roll_dominant_mix)
          page.wait_for_timeout(30)
      page.wait_for_function(
          "document.querySelector('.three-canvas')?.dataset.spacemouseDominantAxis === 'yaw'"
      )
      assert canvas.get_attribute("data-spacemouse-applied-axis-count") == "1"
      assert float(canvas.get_attribute("data-spacemouse-target-roll")) == 0
      assert float(canvas.get_attribute("data-spacemouse-filtered-roll")) == 0
      assert abs(float(canvas.get_attribute("data-spacemouse-target-yaw"))) > 0.1
      assert canvas.get_attribute("data-spacemouse-last-motion") == "yaw"
      emit_vector(page, [0, 0, 0, 0, 0, 0])
      page.wait_for_function(
          "document.querySelector('.spacemouse-axis-hud')?.dataset.state === 'holding'"
      )
      page.wait_for_timeout(700)
      assert axis_hud.get_attribute("data-state") == "holding"
      page.wait_for_function(
          "document.querySelector('.spacemouse-axis-hud')?.dataset.state === 'fading'"
      )
      assert axis_hud.get_attribute("aria-hidden") == "true"
      page.wait_for_function(
          "document.querySelector('.three-canvas')?.dataset.spacemouseMotionState === 'idle'"
      )
      assert canvas.get_attribute("data-spacemouse-applied-axis-count") == "0"

      rotation_before = read_camera(canvas)
      yaw_distance_before = float(canvas.get_attribute("data-effective-camera-distance"))
      yaw_zoom_before = float(canvas.get_attribute("data-optical-zoom"))
      emit_vector(page, scaled_vector(COUPLED_MOTIONS["yaw"], 0.84))
      page.wait_for_timeout(30)
      emit_vector(page, scaled_vector(COUPLED_MOTIONS["yaw"], 0.84))
      page.wait_for_timeout(55)
      target_yaw = abs(float(canvas.get_attribute("data-spacemouse-target-yaw")))
      filtered_yaw = abs(float(canvas.get_attribute("data-spacemouse-filtered-yaw")))
      assert target_yaw > 0.1
      assert 0 < filtered_yaw < target_yaw
      assert canvas.get_attribute("data-spacemouse-motion-state") == "active"
      hold_vector(page, scaled_vector(COUPLED_MOTIONS["yaw"], 0.84))
      rotation_after = read_camera(canvas)
      assert rotation_after != rotation_before
      assert abs(
          float(canvas.get_attribute("data-effective-camera-distance"))
          - yaw_distance_before
      ) < 1e-7
      assert float(canvas.get_attribute("data-optical-zoom")) == yaw_zoom_before
      assert canvas.get_attribute("data-spacemouse-mode") == "rpy"
      assert canvas.get_attribute("data-spacemouse-last-motion") == "yaw"
      assert canvas.get_attribute("data-spacemouse-rotation-distance-policy") == "locked"
      page.wait_for_timeout(85)
      release_yaw = abs(float(canvas.get_attribute("data-spacemouse-filtered-yaw")))
      assert 0 < release_yaw < target_yaw
      assert canvas.get_attribute("data-spacemouse-motion-state") == "settling"

      # Some 3DxWare variants inject an OS wheel event while the yaw cap is
      # moving. It is indistinguishable from a mouse wheel by event metadata,
      # so the recent WebHID motion timestamp must suppress that wheel burst.
      canvas.hover()
      driver_wheel_distance_before = float(
          canvas.get_attribute("data-effective-camera-distance")
      )
      driver_wheel_zoom_before = float(canvas.get_attribute("data-optical-zoom"))
      suppressed_before = int(
          canvas.get_attribute("data-spacemouse-wheel-suppressed-count")
      )
      global_suppressed_before = int(
          control.get_attribute("data-spacemouse-suppressed-pointer-events")
      )
      emit_vector(page, scaled_vector(COUPLED_MOTIONS["yaw"], 0.84))
      page.wait_for_timeout(45)
      page.mouse.wheel(0, -400)
      page.wait_for_timeout(70)
      emit_vector(page, [0, 0, 0, 0, 0, 0])
      assert abs(
          float(canvas.get_attribute("data-effective-camera-distance"))
          - driver_wheel_distance_before
      ) < 1e-7
      assert float(canvas.get_attribute("data-optical-zoom")) == driver_wheel_zoom_before
      assert int(
          canvas.get_attribute("data-spacemouse-wheel-suppressed-count")
      ) >= suppressed_before
      assert int(
          control.get_attribute("data-spacemouse-suppressed-pointer-events")
      ) > global_suppressed_before
      assert control.get_attribute("data-spacemouse-last-suppressed-event") == (
          "wheel"
      )

      # Regression: some driver builds deliver their synthetic wheel event a
      # few milliseconds *before* the matching WebHID RPY report. The short
      # RPY arbitration window must hold that wheel and reject it retroactively.
      page.wait_for_function(
          "document.querySelector('.spacemouse-control')?.dataset.spacemousePointerGuard === 'idle'"
      )
      page.wait_for_timeout(
          int(canvas.get_attribute("data-spacemouse-wheel-guard-ms")) + 30
      )
      early_wheel_distance_before = float(
          canvas.get_attribute("data-effective-camera-distance")
      )
      early_wheel_zoom_before = float(canvas.get_attribute("data-optical-zoom"))
      early_suppressed_before = int(
          canvas.get_attribute("data-spacemouse-wheel-suppressed-count")
      )
      page.mouse.wheel(0, -400)
      assert canvas.get_attribute("data-last-zoom-decision") == (
          "pending-rpy-wheel-arbitration"
      )
      page.wait_for_timeout(8)
      emit_vector(page, scaled_vector(COUPLED_MOTIONS["yaw"], 0.84))
      page.wait_for_timeout(70)
      emit_vector(page, [0, 0, 0, 0, 0, 0])
      assert abs(
          float(canvas.get_attribute("data-effective-camera-distance"))
          - early_wheel_distance_before
      ) < 1e-7
      assert float(canvas.get_attribute("data-optical-zoom")) == early_wheel_zoom_before
      assert int(
          canvas.get_attribute("data-spacemouse-wheel-suppressed-count")
      ) > early_suppressed_before
      assert canvas.get_attribute("data-last-zoom-decision") == (
          "blocked-spacemouse-driver-wheel-race"
      )

      # The same delayed classification must hand a real mouse wheel back when
      # no SpaceMouse report follows it.
      page.wait_for_function(
          "document.querySelector('.spacemouse-control')?.dataset.spacemousePointerGuard === 'idle'"
      )
      page.wait_for_timeout(
          int(canvas.get_attribute("data-spacemouse-wheel-guard-ms")) + 30
      )
      rpy_mouse_wheel_before = float(
          canvas.get_attribute("data-effective-camera-distance")
      )
      page.mouse.wheel(0, -400)
      assert canvas.get_attribute("data-last-zoom-decision") == (
          "pending-rpy-wheel-arbitration"
      )
      page.wait_for_timeout(80)
      assert float(
          canvas.get_attribute("data-effective-camera-distance")
      ) < rpy_mouse_wheel_before
      assert canvas.get_attribute("data-last-zoom-decision") == "accepted-mouse-wheel"

      # Repeated right-key singles cycle the remembered RPY channel in the
      # safe YAW -> PITCH -> ROLL order. Only the selected channel is emitted.
      page.wait_for_timeout(500)
      press_control_button(page, 2)
      page.wait_for_function(
          "document.querySelector('.spacemouse-control')?.dataset.spacemouseSelectedAxis === 'pitch'"
      )
      page.wait_for_function(
          "document.querySelector('.three-canvas')?.dataset.spacemouseSelectedAxis === 'pitch'"
      )
      for _ in range(3):
          emit_vector(page, scaled_vector(COUPLED_MOTIONS["pitch"], 0.82))
          page.wait_for_timeout(30)
      assert canvas.get_attribute("data-spacemouse-dominant-axis") == "pitch"
      assert float(canvas.get_attribute("data-spacemouse-target-roll")) == 0
      assert float(canvas.get_attribute("data-spacemouse-target-yaw")) == 0
      emit_vector(page, [0, 0, 0, 0, 0, 0])
      page.wait_for_timeout(500)
      press_control_button(page, 2)
      page.wait_for_function(
          "document.querySelector('.spacemouse-control')?.dataset.spacemouseSelectedAxis === 'roll'"
      )
      page.wait_for_function(
          "document.querySelector('.three-canvas')?.dataset.spacemouseSelectedAxis === 'roll'"
      )
      page.wait_for_timeout(500)
      press_control_button(page, 2)
      page.wait_for_function(
          "document.querySelector('.spacemouse-control')?.dataset.spacemouseSelectedAxis === 'yaw'"
      )
      page.wait_for_function(
          "document.querySelector('.three-canvas')?.dataset.spacemouseSelectedAxis === 'yaw'"
      )

      # Left physical button selects XYZ. X translates camera and target
      # together along the current XY heading, so it responds without changing
      # orbit distance or optical zoom.
      press_control_button(page, 1)
      page.wait_for_function(
          "document.querySelector('.spacemouse-control')?.dataset.spacemouseMode === 'xyz'"
      )
      page.wait_for_function(
          """document.querySelector('.three-canvas')?.dataset.spacemouseMode === 'xyz'
            && document.querySelector('.three-canvas')?.dataset.spacemouseSelectedAxis === 'x'"""
      )
      x_view_before = read_camera(canvas)
      x_distance_before = float(canvas.get_attribute("data-effective-camera-distance"))
      x_optical_zoom_before = float(canvas.get_attribute("data-optical-zoom"))
      x_input_count_before = int(canvas.get_attribute("data-spacemouse-input-count"))
      x_heading = normalize3((
          x_view_before[3] - x_view_before[0],
          x_view_before[4] - x_view_before[1],
          0,
      ))
      hold_vector(page, scaled_vector(COUPLED_MOTIONS["x"], 0.84))
      x_view_after = read_camera(canvas)
      x_target_delta = tuple(
          x_view_after[index] - x_view_before[index] for index in range(3, 6)
      )
      x_camera_delta = tuple(
          x_view_after[index] - x_view_before[index] for index in range(3)
      )
      assert dot3(x_target_delta, x_heading) > 0
      assert math.sqrt(sum(value * value for value in x_camera_delta)) > 1e-5
      assert abs(
          float(canvas.get_attribute("data-effective-camera-distance"))
          - x_distance_before
      ) < 1e-6
      assert float(canvas.get_attribute("data-optical-zoom")) == x_optical_zoom_before
      assert int(canvas.get_attribute("data-spacemouse-input-count")) > x_input_count_before
      assert canvas.get_attribute("data-spacemouse-forward-implementation") == "world-xy"
      assert "x" in canvas.get_attribute("data-spacemouse-last-motion").split("+")

      page.wait_for_function(
          "document.querySelector('.three-canvas')?.dataset.spacemouseMotionState === 'idle'"
      )
      x_reverse_before = read_camera(canvas)
      hold_vector(page, scaled_vector(COUPLED_MOTIONS["x"], -0.84))
      x_reverse_after = read_camera(canvas)
      x_reverse_delta = tuple(
          x_reverse_after[index] - x_reverse_before[index] for index in range(3, 6)
      )
      assert dot3(x_reverse_delta, x_heading) < 0
      x_input_count_after = int(canvas.get_attribute("data-spacemouse-input-count"))

      # Y/Z pan remains active and can be processed alongside the default
      # keyboard controls without either input mode taking ownership away.
      page.wait_for_timeout(500)
      press_control_button(page, 1)
      page.wait_for_function(
          "document.querySelector('.spacemouse-control')?.dataset.spacemouseSelectedAxis === 'y'"
      )
      page.wait_for_function(
          "document.querySelector('.three-canvas')?.dataset.spacemouseSelectedAxis === 'y'"
      )
      translation_before = read_camera(canvas)
      distance_before = float(canvas.get_attribute("data-effective-camera-distance"))
      page.keyboard.down("w")
      hold_vector(page, scaled_vector(COUPLED_MOTIONS["y"], 0.84))
      page.keyboard.up("w")
      translation_after = read_camera(canvas)
      distance_after = float(canvas.get_attribute("data-effective-camera-distance"))
      assert translation_after != translation_before
      assert abs(distance_after - distance_before) < 1e-6
      spacemouse_input_count = int(canvas.get_attribute("data-spacemouse-input-count"))
      assert spacemouse_input_count > x_input_count_after
      assert int(canvas.get_attribute("data-keyboard-input-count")) > 0
      assert canvas.get_attribute("data-keyboard-enabled") == "true"
      assert canvas.get_attribute("data-spacemouse-mode") == "xyz"
      assert "y" in canvas.get_attribute("data-spacemouse-last-motion").split("+")

      page.wait_for_function(
          "document.querySelector('.three-canvas')?.dataset.spacemouseMotionState === 'idle'"
      )
      y_left_before = read_camera(canvas)
      view_forward = normalize3(tuple(
          y_left_before[index + 3] - y_left_before[index] for index in range(3)
      ))
      view_right = normalize3(cross3(view_forward, y_left_before[6:9]))
      hold_vector(page, scaled_vector(COUPLED_MOTIONS["y"], 0.84))
      y_left_after = read_camera(canvas)
      positive_y_delta = tuple(
          y_left_after[index] - y_left_before[index] for index in range(3, 6)
      )
      assert dot3(positive_y_delta, view_right) < 0

      page.wait_for_function(
          "document.querySelector('.three-canvas')?.dataset.spacemouseMotionState === 'idle'"
      )
      y_right_before = read_camera(canvas)
      hold_vector(page, scaled_vector(COUPLED_MOTIONS["y"], -0.84))
      y_right_after = read_camera(canvas)
      negative_y_delta = tuple(
          y_right_after[index] - y_right_before[index] for index in range(3, 6)
      )
      assert dot3(negative_y_delta, view_right) > 0

      # The calibrated +Z / -Z semantics must move in opposite screen-up
      # directions. This catches the extra sign inversion that previously made
      # a physical upward gesture move the view downward.
      page.wait_for_function(
          "document.querySelector('.three-canvas')?.dataset.spacemouseMotionState === 'idle'"
      )
      page.wait_for_timeout(500)
      press_control_button(page, 1)
      page.wait_for_function(
          "document.querySelector('.spacemouse-control')?.dataset.spacemouseSelectedAxis === 'z'"
      )
      page.wait_for_function(
          "document.querySelector('.three-canvas')?.dataset.spacemouseSelectedAxis === 'z'"
      )
      z_up_before = read_camera(canvas)
      z_distance_before = float(canvas.get_attribute("data-effective-camera-distance"))
      z_zoom_before = float(canvas.get_attribute("data-optical-zoom"))
      hold_vector(page, scaled_vector(COUPLED_MOTIONS["z"], 0.84))
      z_up_after = read_camera(canvas)
      camera_up = z_up_before[6:9]
      positive_z_delta = tuple(
          z_up_after[index] - z_up_before[index] for index in range(3, 6)
      )
      assert sum(a * b for a, b in zip(positive_z_delta, camera_up)) > 0
      assert abs(
          float(canvas.get_attribute("data-effective-camera-distance"))
          - z_distance_before
      ) < 1e-6
      assert float(canvas.get_attribute("data-optical-zoom")) == z_zoom_before

      page.wait_for_function(
          "document.querySelector('.three-canvas')?.dataset.spacemouseMotionState === 'idle'"
      )
      z_down_before = read_camera(canvas)
      hold_vector(page, scaled_vector(COUPLED_MOTIONS["z"], -0.84))
      z_down_after = read_camera(canvas)
      negative_z_delta = tuple(
          z_down_after[index] - z_down_before[index] for index in range(3, 6)
      )
      assert sum(a * b for a, b in zip(negative_z_delta, camera_up)) < 0
      assert "z" in canvas.get_attribute("data-spacemouse-last-motion").split("+")

      # Zoom remains available through the ordinary mouse wheel and is tagged
      # separately so a regression cannot silently hand it back to SpaceMouse.
      wheel_distance_before = float(canvas.get_attribute("data-effective-camera-distance"))
      canvas.hover()
      page.wait_for_timeout(
          int(canvas.get_attribute("data-spacemouse-wheel-guard-ms")) + 40
      )
      page.mouse.wheel(0, -400)
      page.wait_for_timeout(180)
      wheel_distance_after = float(canvas.get_attribute("data-effective-camera-distance"))
      assert wheel_distance_after < wheel_distance_before
      assert canvas.get_attribute("data-last-zoom-source") == "wheel"
      assert canvas.get_attribute("data-last-zoom-decision") == "accepted-mouse-wheel"

      # A refresh restores both browser HID permission and the local habit
      # profile. It must not force the calibration wizard to open again.
      page.reload(wait_until="networkidle")
      page.locator('[data-session-state="ready"]').wait_for()
      page.wait_for_function(
          "document.querySelector('.spacemouse-control')?.dataset.spacemouseState === 'connected'"
      )
      assert control.get_attribute("data-spacemouse-calibrated") == "true"
      assert page.get_by_role("dialog", name="SpaceMouse 首次校准").count() == 0

      trigger.click()
      panel = page.get_by_role("dialog", name="3D鼠标控制器")
      panel.wait_for()
      assert "X 单轴通道已启用" in panel.inner_text()
      assert "仅该语义轴可输出" in panel.inner_text()
      assert "左键循环 X / Y / Z" in panel.inner_text()
      assert "右键循环 YAW / PITCH / ROLL" in panel.inner_text()
      assert "双击同一实体键暂停" in panel.inner_text()
      assert "只执行当前轴" in panel.inner_text()
      assert "缩放始终由鼠标滚轮控制" in panel.inner_text()
      page.wait_for_timeout(220)
      page.screenshot(path="/tmp/atlas-spacemouse-connected.png", full_page=True)
      page.get_by_role("button", name="重新标定").click()
      calibration.wait_for()
      assert calibration.get_attribute("data-calibration-stage") == "intro"
      page.wait_for_function(
          "document.querySelector('.three-canvas')?.dataset.spacemouseCalibrating === 'true'"
      )
      assert canvas.get_attribute("data-spacemouse-calibration-isolation") == "enabled"
      calibration_view_before = read_camera(canvas)
      calibration_distance_before = float(
          canvas.get_attribute("data-effective-camera-distance")
      )
      emit_vector(page, scaled_vector(COUPLED_MOTIONS["yaw"], 0.84))
      page.wait_for_timeout(180)
      emit_vector(page, [0, 0, 0, 0, 0, 0])
      assert read_camera(canvas) == calibration_view_before
      assert float(canvas.get_attribute("data-effective-camera-distance")) == (
          calibration_distance_before
      )
      page.get_by_role("button", name="关闭SpaceMouse校准").click()
      page.wait_for_function(
          "document.querySelector('.three-canvas')?.dataset.spacemouseCalibrating === 'false'"
      )

      print("spacemouse_profile_axes=", sorted(stored_profile["mappings"].keys()))
      print("spacemouse_input_count=", spacemouse_input_count)
      print("page_errors=", errors)
      assert not errors

      # Existing single-axis v1 profiles remain available for migration, but
      # the UI requests a one-time recalibration because those samples cannot
      # retroactively distinguish outward motion from release rebound.
      raw_axes = ["x", "y", "z", "rx", "ry", "rz"]
      control_axes = ["x", "y", "z", "roll", "pitch", "yaw"]
      legacy_profile = {
          "version": 1,
          "model": "3DConnexion SpaceMouse Wireless Bluetooth Edition",
          "mappings": {
              control_axis: {
                  "positive": {"sourceAxis": raw_axis, "sourceSign": 1, "peak": 220},
                  "negative": {"sourceAxis": raw_axis, "sourceSign": -1, "peak": 220},
              }
              for control_axis, raw_axis in zip(control_axes, raw_axes)
          },
          "responseCurve": 1.35,
          "deadzoneRatio": 0.075,
      }
      migration_errors = []
      migration_context = browser.new_context(viewport={"width": 1200, "height": 760})
      migration_context.add_init_script(MOCK_WEBHID)
      migration_context.add_init_script(f"""
        localStorage.setItem(
          'atlas-route-studio:spacemouse-wireless-bt-profile-v1',
          JSON.stringify({json.dumps(legacy_profile)})
        );
        localStorage.setItem('__atlas_mock_hid_granted', 'true');
      """)
      migration_page = migration_context.new_page()
      migration_page.on("pageerror", lambda error: migration_errors.append(str(error)))
      migration_page.goto(BASE_URL, wait_until="networkidle")
      migration_page.locator('[data-session-state="ready"]').wait_for()
      migrated_profile = json.loads(migration_page.evaluate(
          "localStorage.getItem('atlas-route-studio:spacemouse-wireless-bt-profile-v4')"
      ))
      assert migrated_profile["version"] == 4
      assert migrated_profile["calibrationModel"] == "coupled-6d-ridge-v1"
      assert migrated_profile["captureStrategy"] == "legacy-full-gesture-v1"
      assert migrated_profile["migratedFrom"] == (
          "screen-xyz-rpy-v1->single-axis-buttons-v4"
      )
      assert migrated_profile["buttonCalibration"] == "required"
      assert migrated_profile["buttons"] is None
      assert migrated_profile["mappings"]["x"]["positive"]["vector"]["z"] == 220
      assert migrated_profile["mappings"]["y"]["positive"]["vector"]["x"] == -220
      assert migrated_profile["mappings"]["z"]["positive"]["vector"]["y"] == 220
      assert migrated_profile["mappings"]["roll"]["positive"]["vector"]["rx"] == -220
      assert migrated_profile["mappings"]["pitch"]["positive"]["vector"]["ry"] == -220
      assert migrated_profile["mappings"]["yaw"]["positive"]["vector"]["rz"] == 220
      assert len(migrated_profile["decoder"]) == 6
      migration_calibration = migration_page.get_by_role(
          "dialog", name="SpaceMouse 首次校准"
      )
      migration_calibration.wait_for()
      assert migration_calibration.get_attribute("data-calibration-stage") == "intro"
      assert not migration_errors
      migration_context.close()
      browser.close()


if __name__ == "__main__":
    run()
