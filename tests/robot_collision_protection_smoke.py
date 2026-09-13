import os

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:22120")


def ply_payload(name, points, faces=None):
    faces = faces or []
    rows = "\n".join(f"{x:.9f} {y:.9f} {z:.9f}" for x, y, z in points)
    face_rows = "\n".join(
        f"{len(face)} {' '.join(str(index) for index in face)}" for face in faces
    )
    source = (
        "ply\n"
        "format ascii 1.0\n"
        f"element vertex {len(points)}\n"
        "property float x\n"
        "property float y\n"
        "property float z\n"
        f"element face {len(faces)}\n"
        "property list uchar int vertex_indices\n"
        "end_header\n"
        f"{rows}\n{face_rows}\n"
    )
    return {
        "name": name,
        "mimeType": "application/octet-stream",
        "buffer": source.encode("utf-8"),
    }


def wait_for_robot(page):
    page.wait_for_function(
        "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
        timeout=180_000,
    )


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

        page.goto(BASE_URL, wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.get_by_role("tab", name="虚拟示教与相机").click()
        joint_toggle = page.get_by_role("button", name="隐藏全关节浮动窗口")
        if joint_toggle.count() and joint_toggle.is_visible():
            joint_toggle.click()

        panel = page.get_by_label("虚拟示教", exact=True)
        guard = page.get_by_label("自碰撞保护", exact=True)
        toggle = page.get_by_role("button", name="开启自碰撞保护")
        assert guard.is_visible()
        assert guard.get_attribute("data-protection-default") == "off"
        assert guard.get_attribute("data-bottom-structure-policy") == "excluded"
        assert panel.get_attribute("data-collision-protection-enabled") == "false"
        assert panel.get_attribute("data-collision-safety-threshold") == "0.1"
        assert toggle.is_disabled()

        map_input = page.locator('input[type="file"][accept=".ply"]')
        map_input.set_input_files(
            ply_payload(
                "collision-safe-map.ply",
                [(20, 20, 20), (20.1, 20, 20), (20, 20.1, 20), (20, 20, 20.1)],
            )
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.get_by_role("button", name="加载机器人", exact=True).click()
        page.get_by_role("option", name="加载机器人 botx_abx_zivid_m70").click()
        wait_for_robot(page)

        canvas = page.locator(".three-canvas")
        toggle = page.get_by_role("button", name="开启自碰撞保护")
        assert not toggle.is_disabled()
        assert toggle.get_attribute("aria-pressed") == "false"
        assert canvas.get_attribute("data-collision-protection-enabled") == "false"
        assert canvas.get_attribute("data-collision-worker") == "inactive"
        assert page.locator(".robot-collision-alert").count() == 0

        toggle.click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.collisionState === 'safe'"
        )
        assert panel.get_attribute("data-collision-protection-enabled") == "true"
        assert guard.get_attribute("class").endswith("is-safe")
        assert canvas.get_attribute("data-collision-worker") == "dedicated"
        assert canvas.get_attribute("data-collision-safety-distance") == "0.1"
        assert int(canvas.get_attribute("data-collision-indexed-points")) >= 4
        assert int(canvas.get_attribute("data-collision-monitored-link-count")) > 0
        assert int(canvas.get_attribute("data-collision-monitored-proxy-count")) > 0
        excluded = canvas.get_attribute("data-collision-excluded-links").split(",")
        assert "base_link" in excluded
        assert any(name.startswith("wheel_") for name in excluded)
        assert "arm_right_baselink" not in excluded
        safe_alert = page.locator(".robot-collision-alert.is-safe")
        assert safe_alert.is_visible()
        assert "非底盘结构安全" in safe_alert.inner_text()
        assert "≥100 mm" in safe_alert.inner_text()

        probe = tuple(
            float(value)
            for value in canvas.get_attribute("data-collision-probe-point").split(",")
        )
        probe_link = canvas.get_attribute("data-collision-probe-link")
        assert len(probe) == 3
        assert probe_link
        assert probe_link not in excluded

        page.get_by_role("button", name="关闭自碰撞保护").click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.collisionProtectionEnabled === 'false'"
        )
        assert canvas.get_attribute("data-collision-worker") == "inactive"
        assert canvas.get_attribute("data-collision-highlighted-links") == ""
        assert page.locator(".robot-collision-alert").count() == 0

        epsilon = 0.001
        collision_points = [
            probe,
            (probe[0] + epsilon, probe[1], probe[2]),
            (probe[0], probe[1] + epsilon, probe[2]),
            (probe[0], probe[1], probe[2] + epsilon),
        ]
        map_input.set_input_files(
            ply_payload("collision-probe-map.ply", collision_points, [(0, 1, 2)])
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.wait_for_function(
            "document.querySelector('.map-identity')?.textContent.includes('collision-probe-map.ply')"
        )
        wait_for_robot(page)
        canvas = page.locator(".three-canvas")
        page.get_by_role("button", name="开启自碰撞保护").click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.collisionState === 'collision'"
        )
        collision_links = canvas.get_attribute("data-collision-links").split(",")
        assert probe_link in collision_links
        assert int(canvas.get_attribute("data-collision-mesh-samples")) > 0
        assert canvas.get_attribute("data-collision-highlight-color") == "#ff4545"
        collision_alert = page.locator(".robot-collision-alert.is-collision")
        assert collision_alert.is_visible()
        assert "检测到环境干涉" in collision_alert.inner_text()
        assert "红色部件" in collision_alert.inner_text()
        page.get_by_role("button", name="定位机器人模型").click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotControlEnabled === 'true'"
        )
        observed_near = False
        observed_safe_after_near = False
        for _ in range(80):
            previous = page.evaluate(
                """() => {
                  const data = document.querySelector('.three-canvas')?.dataset;
                  return { count: Number(data?.collisionCheckCount), x: Number(data?.robotX) };
                }"""
            )
            page.keyboard.press("w")
            page.wait_for_function(
                "previous => Number(document.querySelector('.three-canvas')?.dataset.robotX) > previous + 0.04",
                arg=previous["x"],
                timeout=5_000,
            )
            try:
                page.wait_for_function(
                    "previous => Number(document.querySelector('.three-canvas')?.dataset.collisionCheckCount) > previous",
                    arg=previous["count"],
                    timeout=5_000,
                )
            except Exception:
                print(
                    "collision_check_stall=",
                    page.evaluate(
                        """() => ({ ...document.querySelector('.three-canvas')?.dataset })"""
                    ),
                    flush=True,
                )
                raise
            snapshot = page.evaluate(
                """() => ({ ...document.querySelector('.three-canvas')?.dataset })"""
            )
            state = snapshot.get("collisionState")
            if state == "near" and not observed_near:
                observed_near = True
                distance = float(snapshot["collisionMinimumDistance"])
                assert 0.008 < distance < 0.1
                assert snapshot["collisionNearLinks"]
                assert snapshot["collisionHighlightColor"] == "#ffc84a"
                near_alert = page.locator(".robot-collision-alert.is-near")
                assert near_alert.is_visible()
                assert "进入 100 mm 安全边界" in near_alert.inner_text()
            if observed_near and state == "safe":
                observed_safe_after_near = True
                break

        assert observed_near
        assert observed_safe_after_near
        assert canvas.get_attribute("data-collision-highlighted-links") == ""
        assert canvas.get_attribute("data-collision-highlight-color") == "none"
        page.screenshot(path="/tmp/atlas-collision-protection.png", full_page=True)

        # The protection state is deliberately not persisted: refresh should
        # restore the workspace but must not silently reallocate the worker.
        page.reload(wait_until="domcontentloaded")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        wait_for_robot(page)
        page.get_by_role("tab", name="虚拟示教与相机").click(force=True)
        panel = page.get_by_label("虚拟示教", exact=True)
        canvas = page.locator(".three-canvas")
        assert panel.get_attribute("data-collision-protection-enabled") == "false"
        assert panel.get_attribute("data-collision-state") == "disabled"
        assert canvas.get_attribute("data-collision-worker") == "inactive"
        assert page.get_by_role("button", name="开启自碰撞保护").get_attribute(
            "aria-pressed"
        ) == "false"

        print("probe_link=", probe_link)
        print("excluded_links=", excluded)
        print("collision_links=", collision_links)
        print("near_transition=", observed_near)
        print("refresh_default_off=", True)
        print("page_errors=", page_errors)
        print("console_errors=", console_errors)
        assert not page_errors
        assert not console_errors
        browser.close()


if __name__ == "__main__":
    run()
