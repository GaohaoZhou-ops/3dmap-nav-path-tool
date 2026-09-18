import base64
import json
import os
import subprocess
import tempfile
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")


def run():
    page_errors = []
    with tempfile.TemporaryDirectory(prefix="atlas-project-directory-") as temporary:
        fixture_root = Path(temporary)
        fixture_zip = fixture_root / "fixture.zip"
        fixture_directory = fixture_root / "fixture.atlas-project"
        fixture_directory.mkdir()
        subprocess.run(
            ["node", "tests/project_archive_smoke.mjs", str(fixture_zip)],
            check=True,
            capture_output=True,
            text=True,
        )
        with zipfile.ZipFile(fixture_zip) as archive:
            archive.extractall(fixture_directory)
        encoded_project_files = {
            str(path.relative_to(fixture_directory)).replace(os.sep, "/"):
                base64.b64encode(path.read_bytes()).decode("ascii")
            for path in fixture_directory.rglob("*")
            if path.is_file()
        }

        with sync_playwright() as playwright:
            options = {"headless": True}
            if CHROME.exists():
                options["executable_path"] = str(CHROME)
            browser = playwright.chromium.launch(**options)
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.add_init_script(
                "Object.defineProperty(window, 'showDirectoryPicker', "
                "{ value: undefined, configurable: true });"
            )
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.goto(f"{BASE_URL.rstrip('/')}/workbench", wait_until="networkidle")
            page.locator('[data-session-state="ready"]').wait_for()

            load_button = page.get_by_role("button", name="加载工程", exact=True)
            assert load_button.is_visible()
            assert load_button.is_enabled()
            assert load_button.get_attribute("data-project-directory-picker") == "true"
            assert load_button.get_attribute("data-project-directory-state") == "detached"
            assert page.get_by_role("button", name="打开上一次工程").count() == 0
            assert page.get_by_role("button", name="加载路径").count() == 0

            with page.expect_file_chooser() as chooser_info:
                load_button.click()
            chooser = chooser_info.value
            assert chooser.is_multiple()
            chooser.set_files(str(fixture_directory))
            page.get_by_text("工程目录（只读）已加载", exact=False).wait_for()
            assert load_button.get_attribute("data-project-directory-state") == "readonly"
            assert page.get_by_text("PROJECT READ ONLY", exact=True).is_visible()
            directory_input = page.locator('input[type="file"][webkitdirectory]')
            assert directory_input.count() == 1
            assert directory_input.get_attribute("multiple") is not None

            legacy_input = page.locator('input[type="file"][accept*=".zip"]')
            assert ".json" in (legacy_input.get_attribute("accept") or "")

            page.screenshot(path="/tmp/atlas-load-project-button.png", full_page=True)
            assert not page_errors

            picker_page = browser.new_page(viewport={"width": 1440, "height": 900})
            picker_page.add_init_script(
                "window.__atlasPickerCalls = [];"
                "window.showDirectoryPicker = async (options) => {"
                "  window.__atlasPickerCalls.push(options);"
                "  throw new DOMException('cancelled', 'AbortError');"
                "};"
            )
            picker_page.on("pageerror", lambda error: page_errors.append(str(error)))
            picker_page.goto(f"{BASE_URL.rstrip('/')}/workbench", wait_until="networkidle")
            picker_page.locator('[data-session-state="ready"]').wait_for()
            picker_page.get_by_role("button", name="加载工程", exact=True).click()
            picker_page.wait_for_function("window.__atlasPickerCalls.length === 1")
            picker_options = picker_page.evaluate("window.__atlasPickerCalls[0]")
            assert picker_options["mode"] == "readwrite"
            assert picker_options["id"] == "atlas-virtual-teaching-project"
            assert picker_page.get_by_role("button", name="加载工程", exact=True).is_enabled()
            assert not page_errors

            writable_page = browser.new_page(viewport={"width": 1440, "height": 900})
            writable_page.add_init_script(
                f"""
                (() => {{
                  const encoded = {json.dumps(encoded_project_files)};
                  const files = new Map(Object.entries(encoded).map(([path, value]) => {{
                    const binary = atob(value);
                    return [path, Uint8Array.from(binary, (char) => char.charCodeAt(0))];
                  }}));
                  const directories = new Set(['']);
                  for (const path of files.keys()) {{
                    const parts = path.split('/');
                    parts.pop();
                    let prefix = '';
                    for (const part of parts) {{
                      prefix = prefix ? `${{prefix}}/${{part}}` : part;
                      directories.add(prefix);
                    }}
                  }}
                  window.__atlasWrittenPaths = [];
                  class MemoryFileHandle {{
                    kind = 'file';
                    constructor(path) {{ this.path = path; this.name = path.split('/').at(-1); }}
                    async getFile() {{ return new File([files.get(this.path)], this.name); }}
                    async createWritable() {{
                      const path = this.path;
                      return {{
                        write: async (value) => {{
                          if (value instanceof Uint8Array) files.set(path, new Uint8Array(value));
                          else if (value instanceof ArrayBuffer) files.set(path, new Uint8Array(value));
                          else files.set(path, new Uint8Array(await new Blob([value]).arrayBuffer()));
                          window.__atlasWrittenPaths.push(path);
                        }},
                        close: async () => {{}},
                        abort: async () => {{}},
                      }};
                    }}
                  }}
                  class MemoryDirectoryHandle {{
                    kind = 'directory';
                    constructor(prefix = '', name = 'fixture.atlas-project') {{
                      this.prefix = prefix;
                      this.name = name;
                    }}
                    async queryPermission() {{ return 'granted'; }}
                    async requestPermission() {{ return 'granted'; }}
                    async getDirectoryHandle(name, options = {{}}) {{
                      const path = this.prefix ? `${{this.prefix}}/${{name}}` : name;
                      if (!directories.has(path) && !options.create) {{
                        throw new DOMException('Not found', 'NotFoundError');
                      }}
                      directories.add(path);
                      return new MemoryDirectoryHandle(path, name);
                    }}
                    async getFileHandle(name, options = {{}}) {{
                      const path = this.prefix ? `${{this.prefix}}/${{name}}` : name;
                      if (!files.has(path) && !options.create) {{
                        throw new DOMException('Not found', 'NotFoundError');
                      }}
                      if (!files.has(path)) files.set(path, new Uint8Array());
                      return new MemoryFileHandle(path);
                    }}
                  }}
                  window.showDirectoryPicker = async () => new MemoryDirectoryHandle();
                }})();
                """
            )
            writable_page.on("pageerror", lambda error: page_errors.append(str(error)))
            writable_page.goto(f"{BASE_URL.rstrip('/')}/workbench", wait_until="networkidle")
            writable_page.locator('[data-session-state="ready"]').wait_for()
            writable_button = writable_page.get_by_role("button", name="加载工程", exact=True)
            writable_button.click()
            writable_page.locator(
                '[data-project-directory-state="synced"]'
            ).wait_for(timeout=15_000)
            writable_page.evaluate("window.__atlasWrittenPaths.length = 0")
            writable_page.get_by_role("button", name="切换点云颜色模式").click()
            writable_page.wait_for_function(
                "window.__atlasWrittenPaths.includes('config/project.json') "
                "&& window.__atlasWrittenPaths.includes('manifest.json')",
                timeout=15_000,
            )
            written_paths = writable_page.evaluate("window.__atlasWrittenPaths")
            assert "environment/positions.f32le" not in written_paths
            assert writable_button.get_attribute("data-project-directory-state") == "synced"
            assert writable_page.get_by_text("PROJECT SYNCED", exact=True).is_visible()
            assert not page_errors
            browser.close()

    print("load_project_button=ok")
    print("project_directory_chooser=ok")
    print("project_directory_readwrite_request=ok")
    print("project_directory_incremental_autosave=ok")
    print("legacy_zip_fallback=ok")


if __name__ == "__main__":
    run()
