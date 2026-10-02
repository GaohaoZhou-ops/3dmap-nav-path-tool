import base64
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

from project_load_modes_smoke import (
    BASE_URL, CHROME, LABELS, assert_mode, assert_rejected, make_fixtures,
    open_loader, wait_ready, workspaces,
)


def run():
    errors = []
    with tempfile.TemporaryDirectory(prefix="atlas-file-picker-") as temporary, sync_playwright() as p:
        root = Path(temporary)
        make_fixtures(root)
        options = {"headless": True}
        if CHROME.exists():
            options["executable_path"] = str(CHROME)
        browser = p.chromium.launch(**options)
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.add_init_script("""
              window.__guidePickerCalls = [];
              window.__guideSelection = { error: 'AbortError' };
              window.showOpenFilePicker = async (options) => {
                window.__guidePickerCalls.push(options);
                const selection = window.__guideSelection;
                if (selection.error) throw new DOMException('picker test', selection.error);
                return [{ getFile: async () => new File([
                  Uint8Array.from(atob(selection.bytes), c => c.charCodeAt(0))
                ], selection.name) }];
              };
            """)
            page.goto(BASE_URL, wait_until="networkidle")
            wait_ready(page)

            # Native cancellation keeps the welcome page ready for another try.
            open_loader(page, "map")
            page.get_by_role("button", name="加载工程引导文件", exact=True).click()
            page.locator('[data-app-page="home"]').wait_for()
            assert not page.locator(".toast-message").count()

            for mode, extension in (("map", "zip"), ("independent", "zip"), ("map", "json"), ("independent", "json")):
                open_loader(page, mode)
                page.evaluate("selection => window.__guideSelection = selection", {
                    "name": f"{mode}.{extension.upper()}",
                    "bytes": base64.b64encode((root / f"{mode}.{extension}").read_bytes()).decode(),
                })
                page.get_by_role("button", name="加载工程引导文件", exact=True).click()
                assert_mode(page, mode)
                call = page.evaluate("window.__guidePickerCalls.at(-1)")
                assert call["id"] == f"atlas-project-guide-{mode}"
                assert call["multiple"] is False
                assert call["excludeAcceptAllOption"] is True
                assert call["types"][0]["accept"] == {
                    "application/json": [".json"], "application/zip": [".zip"],
                }
            assert len(workspaces(page)) == 2

            # Type validation still runs when the native picker supplies a file.
            open_loader(page, "map")
            snapshot = workspaces(page)
            page.get_by_role("button", name="加载工程引导文件", exact=True).click()
            assert_rejected(page, "independent", snapshot)

            # A restricted picker falls back to the same filtered file input;
            # bypassing its OS filter must not replace the current workspace.
            for error in ("SecurityError", "NotSupportedError"):
                open_loader(page, "map")
                page.evaluate("error => window.__guideSelection = {error}", error)
                with page.expect_file_chooser() as chooser_info:
                    page.get_by_role("button", name="加载工程引导文件", exact=True).click()
                chooser = chooser_info.value
                assert not chooser.is_multiple()
                assert chooser.element.get_attribute("accept") == ".json,.zip"
                chooser.set_files({"name": "wrong-format.ply", "mimeType": "application/octet-stream", "buffer": b"ply"})
                page.get_by_text("请选择 JSON 工程配置或 ZIP 工程包", exact=True).wait_for()
                assert page.locator('[data-app-page="home"]').is_visible()
                assert workspaces(page) == snapshot

            page.evaluate("window.showOpenFilePicker = undefined")
            for mode in LABELS:
                open_loader(page, mode)
                with page.expect_file_chooser() as chooser_info:
                    page.get_by_role("button", name="加载工程引导文件", exact=True).click()
                assert chooser_info.value.element.get_attribute("accept") == ".json,.zip"
                chooser_info.value.set_files(str(root / f"{mode}.zip"))
                assert_mode(page, mode)

            print("native_json_zip_filter_cancel_and_mode_validation=ok")
            print("fallback_filter_and_unsupported_file_rejection=ok")
            assert not errors, errors
        finally:
            browser.close()


if __name__ == "__main__":
    run()
