import json
import zipfile
from pathlib import Path


PROJECT_CONFIG_PATH = "config/project.json"


def read_exported_project(download):
    path = Path(download.path())
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            return json.loads(archive.read(PROJECT_CONFIG_PATH))
    return json.loads(path.read_text())


def read_exported_archive(download):
    path = Path(download.path())
    assert zipfile.is_zipfile(path), f"expected ZIP archive: {path}"
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        manifest = json.loads(archive.read("manifest.json"))
        project_bytes = archive.read(PROJECT_CONFIG_PATH)
        project = json.loads(project_bytes)
        return {
            "path": path,
            "names": names,
            "manifest": manifest,
            "project": project,
            "project_bytes": project_bytes,
            "files": {name: archive.read(name) for name in names if not name.endswith("/")},
        }
