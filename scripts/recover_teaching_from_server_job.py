#!/usr/bin/env python3
"""Convert a verified parking-merge Server job into a portable project ZIP.

The Server job deliberately excludes camera RGB/point-cloud media.  It does,
however, contain the complete parking hierarchy, full-body joints, calibrated
optical targets, map geometry, and collision robot resources.  This utility
binds those records back to the exact local PLY/robot package and emits the v2
portable project format consumed by the web application's “加载工程” action.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import mmap
import os
import re
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree


PROJECT_FORMAT = "atlas-route-studio-project"
PROJECT_ARCHIVE_VERSION = 2
SERVER_JOB_FORMAT = "atlas-parking-merge-server-job"
PROJECT_FILE = "config/project.json"
MAP_META_FILE = "environment/map.json"
MAP_POSITIONS_FILE = "environment/positions.f32le"
MAP_COLORS_FILE = "environment/colors.rgb8"
MAP_TRIANGLES_FILE = "environment/triangles.u32le"
ROBOT_META_FILE = "robot/robot.json"
MANIFEST_FILE = "manifest.json"
CHUNK_SIZE = 4 * 1024 * 1024

PLY_SCALAR_BYTES = {
    "char": 1,
    "int8": 1,
    "uchar": 1,
    "uint8": 1,
    "short": 2,
    "int16": 2,
    "ushort": 2,
    "uint16": 2,
    "int": 4,
    "int32": 4,
    "uint": 4,
    "uint32": 4,
    "float": 4,
    "float32": 4,
    "double": 8,
    "float64": 8,
}

MIME_TYPES = {
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".stl": "model/stl",
    ".urdf": "application/xml",
    ".xml": "application/xml",
}

ZIVID_OVERRIDE = {
    "package://botx_abx_zivid_m70/meshes/ZividTwo.stl":
        "botx_abx_zivid_m70/meshes/zivid_2_m70_official.glb",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def file_time(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def stable_json_bytes(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def sha256_stream(stream) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    while True:
        chunk = stream.read(CHUNK_SIZE)
        if not chunk:
            break
        digest.update(chunk)
        size += len(chunk)
    return digest.hexdigest(), size


def sha256_file(path: Path) -> tuple[str, int]:
    with path.open("rb") as stream:
        return sha256_stream(stream)


def safe_archive_path(value: str) -> str:
    path = PurePosixPath(str(value).replace("\\", "/"))
    if path.is_absolute() or not path.parts or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError(f"不安全的 ZIP 路径：{value}")
    return path.as_posix()


def progress(index: int, total: int, message: str) -> None:
    width = 24
    ratio = 1 if total <= 0 else max(0, min(1, index / total))
    filled = round(width * ratio)
    bar = "█" * filled + "░" * (width - filled)
    print(f"[{bar}] {ratio * 100:5.1f}%  {message}", flush=True)


def verify_server_job(archive: zipfile.ZipFile, manifest: dict) -> None:
    if manifest.get("format") != SERVER_JOB_FORMAT:
        raise ValueError("输入文件不是停车点 Server 计算包")
    records = manifest.get("files") or []
    known = set(archive.namelist())
    for index, record in enumerate(records, 1):
        path = safe_archive_path(record.get("path", ""))
        if path not in known:
            raise ValueError(f"Server 计算包缺少文件：{path}")
        with archive.open(path) as stream:
            digest, size = sha256_stream(stream)
        if size != int(record.get("byteLength", -1)):
            raise ValueError(f"Server 计算包文件长度不匹配：{path}")
        if digest != str(record.get("sha256", "")).lower():
            raise ValueError(f"Server 计算包 SHA-256 校验失败：{path}")
        progress(index, len(records), f"校验源归档 · {path}")


def parse_ply_color_layout(path: Path) -> tuple[int, int, dict[str, int], int]:
    header_size = 0
    vertex_count = None
    vertex_stride = 0
    offsets: dict[str, int] = {}
    current_element = None
    with path.open("rb") as stream:
        first = stream.readline()
        header_size += len(first)
        if first.strip() != b"ply":
            raise ValueError("地图不是 PLY 文件")
        while True:
            raw = stream.readline()
            if not raw:
                raise ValueError("PLY 头缺少 end_header")
            header_size += len(raw)
            line = raw.decode("ascii", "strict").strip()
            if line == "format binary_little_endian 1.0":
                pass
            elif line.startswith("format "):
                raise ValueError("恢复颜色仅支持 binary_little_endian PLY")
            elif line.startswith("element "):
                _, current_element, count = line.split()
                if current_element == "vertex":
                    vertex_count = int(count)
            elif line.startswith("property ") and current_element == "vertex":
                parts = line.split()
                if len(parts) != 3 or parts[1] == "list":
                    raise ValueError("PLY 顶点中存在不支持的属性")
                scalar_type, name = parts[1:]
                if scalar_type not in PLY_SCALAR_BYTES:
                    raise ValueError(f"不支持的 PLY 属性类型：{scalar_type}")
                offsets[name] = vertex_stride
                vertex_stride += PLY_SCALAR_BYTES[scalar_type]
            elif line == "end_header":
                break
    if vertex_count is None or vertex_stride <= 0:
        raise ValueError("PLY 顶点声明无效")
    if any(name not in offsets for name in ("red", "green", "blue")):
        raise ValueError("原始 PLY 不包含 RGB 顶点颜色")
    return header_size, vertex_count, offsets, vertex_stride


def extract_ply_colors(path: Path, expected_count: int) -> bytearray:
    header_size, vertex_count, offsets, vertex_stride = parse_ply_color_layout(path)
    if vertex_count != expected_count:
        raise ValueError("本地 PLY 点数与 Server 归档不一致")
    colors = bytearray(vertex_count * 3)
    with path.open("rb") as stream:
        mapped = mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ)
        view = memoryview(mapped)
        try:
            vertex_end = header_size + vertex_count * vertex_stride
            if vertex_end > len(view):
                raise ValueError("PLY 顶点数据被截断")
            for channel, name in enumerate(("red", "green", "blue")):
                start = header_size + offsets[name]
                channel_data = bytes(view[start:vertex_end:vertex_stride])
                if len(channel_data) != vertex_count:
                    raise ValueError(f"PLY {name} 通道长度异常")
                colors[channel::3] = channel_data
        finally:
            view.release()
            mapped.close()
    return colors


def resolve_robot_reference(reference: str, descriptor_path: str) -> str:
    if reference in ZIVID_OVERRIDE:
        return ZIVID_OVERRIDE[reference]
    package_match = re.match(r"^package://([^/]+)/(.+)$", reference, re.IGNORECASE)
    if package_match:
        candidate = PurePosixPath(package_match.group(1), package_match.group(2))
    else:
        candidate = PurePosixPath(descriptor_path).parent / reference
    return safe_archive_path(candidate.as_posix())


def collect_robot_files(robots_dir: Path, relative_path: str) -> list[tuple[str, Path]]:
    descriptor_path = safe_archive_path(relative_path)
    urdf_path = robots_dir / descriptor_path
    if not urdf_path.is_file():
        raise ValueError(f"找不到机器人描述文件：{urdf_path}")
    root = ElementTree.parse(urdf_path).getroot()
    paths = {descriptor_path}
    for mesh in root.findall(".//mesh"):
        reference = mesh.get("filename")
        if reference:
            paths.add(resolve_robot_reference(reference, descriptor_path))
    package_path = PurePosixPath(descriptor_path).parts[0]
    for optional in ("package.xml", "web-model.json", "RESOURCE_MANIFEST.sha256"):
        relative = f"{package_path}/{optional}"
        if (robots_dir / relative).is_file():
            paths.add(relative)
    files = []
    for relative in sorted(paths):
        local_path = robots_dir / relative
        if not local_path.is_file():
            raise ValueError(f"机器人依赖缺失：{relative}")
        files.append((relative, local_path))
    return files


def normalize_pose(value: dict | None) -> dict:
    value = value if isinstance(value, dict) else {}
    position = value.get("position") if isinstance(value.get("position"), dict) else value
    rpy = value.get("rpy") if isinstance(value.get("rpy"), dict) else value
    return {
        "frameId": str(value.get("frameId") or value.get("frame") or "map"),
        "position": {axis: float(position.get(axis, 0) or 0) for axis in "xyz"},
        "rpy": {
            axis: float(rpy.get(axis, 0) or 0)
            for axis in ("roll", "pitch", "yaw")
        },
    }


def adapt_task(task: dict, source_created_at: str, task_created_at: str) -> dict:
    adapted = {
        "id": str(task.get("id") or "recovered-teaching-task"),
        "name": str(task.get("name") or "恢复的示教任务"),
        "createdAt": task_created_at,
        "updatedAt": source_created_at,
        "coordinateFrame": str(task.get("coordinateFrame") or "map"),
        "robot": copy.deepcopy(task.get("robot") or {}),
        "map": copy.deepcopy(task.get("map") or {}),
        "parkingPoints": [],
    }
    for parking_index, parking in enumerate(task.get("parkingPoints") or []):
        adapted_parking = {
            "id": str(parking.get("id") or f"recovered-parking-{parking_index + 1}"),
            "name": str(parking.get("name") or f"停车点 P{parking_index + 1:02d}"),
            "sequence": parking_index + 1,
            "createdAt": task_created_at if parking_index == 0 else "",
            "updatedAt": source_created_at,
            "mapPose": normalize_pose(parking.get("mapPose")),
            "poses": [],
            "mergeHistory": [],
        }
        for pose_index, pose in enumerate(parking.get("poses") or []):
            joint_values = {
                str(name): float(value)
                for name, value in sorted((pose.get("jointValues") or {}).items())
            }
            optical_targets = copy.deepcopy(pose.get("opticalTargets") or {})
            adapted_parking["poses"].append({
                "id": str(pose.get("id") or f"recovered-pose-{parking_index + 1}-{pose_index + 1}"),
                "name": str(pose.get("name") or f"A{pose_index + 1:02d}"),
                "sequence": pose_index + 1,
                "capturedAt": "",
                "mapPose": normalize_pose(pose.get("mapPose") or parking.get("mapPose")),
                "fullBodyJoints": {
                    "angularUnit": "degree",
                    "linearUnit": "meter",
                    "source": "urdf-movable-joints",
                    "count": len(joint_values),
                    "values": joint_values,
                },
                "opticalTargets": optical_targets,
                "cameraCapture": None,
                "replanningHistory": [],
            })
        adapted["parkingPoints"].append(adapted_parking)
    return adapted


def pose_distance(left: dict, right: dict) -> float:
    a = normalize_pose(left)["position"]
    b = normalize_pose(right)["position"]
    return math.sqrt(sum((a[axis] - b[axis]) ** 2 for axis in "xyz"))


def sanitize_segment(value: str, fallback: str) -> str:
    result = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(value))
    result = re.sub(r"\s+", "_", result)
    result = re.sub(r"_+", "_", result).strip(". _")[:56]
    return result or fallback


class ArchiveWriter:
    def __init__(self, archive: zipfile.ZipFile):
        self.archive = archive
        self.records: list[dict] = []

    def _info(self, path: str, compression_level: int) -> zipfile.ZipInfo:
        info = zipfile.ZipInfo(safe_archive_path(path), datetime.now().timetuple()[:6])
        info.compress_type = zipfile.ZIP_STORED if compression_level == 0 else zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        info._compresslevel = compression_level
        return info

    def write_stream(self, path: str, stream, role: str, compression_level: int = 6) -> dict:
        digest = hashlib.sha256()
        size = 0
        with self.archive.open(
            self._info(path, compression_level), "w", force_zip64=True
        ) as target:
            while True:
                chunk = stream.read(CHUNK_SIZE)
                if not chunk:
                    break
                target.write(chunk)
                digest.update(chunk)
                size += len(chunk)
        record = {
            "path": safe_archive_path(path),
            "role": role,
            "byteLength": size,
            "sha256": digest.hexdigest(),
        }
        self.records.append(record)
        return record

    def write_bytes(self, path: str, body, role: str, compression_level: int = 6) -> dict:
        view = memoryview(body)
        try:
            with tempfile.SpooledTemporaryFile(max_size=CHUNK_SIZE) as stream:
                stream.write(view)
                stream.seek(0)
                return self.write_stream(path, stream, role, compression_level)
        finally:
            view.release()

    def write_file(self, path: str, source: Path, role: str, compression_level: int = 1) -> dict:
        with source.open("rb") as stream:
            return self.write_stream(path, stream, role, compression_level)


def role_for_robot(path: str) -> str:
    if path.endswith(".urdf"):
        return "robot-resource"
    return "robot-resource"


def build_archive(args) -> tuple[Path, dict]:
    source_path = args.input.resolve()
    map_path = args.map.resolve()
    robots_dir = args.robots_dir.resolve()
    output_path = args.output.resolve()
    recovered_at = utc_now()

    if not source_path.is_file():
        raise ValueError(f"找不到 Server 计算包：{source_path}")
    if not map_path.is_file():
        raise ValueError(f"找不到原始地图：{map_path}")

    with zipfile.ZipFile(source_path) as source:
        manifest = json.loads(source.read(MANIFEST_FILE))
        verify_server_job(source, manifest)
        task = json.loads(source.read("input/task.json"))
        server_config = json.loads(source.read("input/config.json"))
        environment = json.loads(source.read("environment/environment.json"))

        expected_task_digest = manifest.get("binding", {}).get("task", {}).get("digest")
        actual_task_digest = hashlib.sha256(stable_json_bytes(task)).hexdigest()
        if expected_task_digest and actual_task_digest != expected_task_digest:
            raise ValueError("Server 计算任务身份摘要不一致")

        binding = manifest.get("binding") or {}
        map_binding = binding.get("map") or {}
        robot_binding = binding.get("robot") or {}
        source_hash, source_size = sha256_file(map_path)
        if source_hash != map_binding.get("sourceHash"):
            raise ValueError("本地 PLY 与 Server 计算包绑定的地图不一致")
        if source_size != int(environment.get("source", {}).get("byteLength", -1)):
            raise ValueError("本地 PLY 文件长度与 Server 计算包不一致")

        robot_relative_path = str(
            task.get("robot", {}).get("relativePath")
            or robot_binding.get("relativePath")
            or ""
        )
        robot_files = collect_robot_files(robots_dir, robot_relative_path)
        primary_path = robots_dir / robot_relative_path
        primary_hash, _ = sha256_file(primary_path)
        if primary_hash != robot_binding.get("primarySha256"):
            raise ValueError("本地机器人 URDF 与 Server 计算包不一致")

        point_count = int(environment["geometry"]["pointCount"])
        triangle_count = int(environment["geometry"]["triangleCount"])
        if point_count != int(map_binding.get("pointCount", -1)):
            raise ValueError("Server 计算包地图点数声明不一致")
        if triangle_count != int(map_binding.get("triangleCount", -1)):
            raise ValueError("Server 计算包地图面数声明不一致")

        progress(0, 1, "提取原始 PLY 顶点颜色")
        colors = extract_ply_colors(map_path, point_count)
        progress(1, 1, f"颜色恢复完成 · {len(colors):,} bytes")

        task_created_at = args.task_created_at or str(manifest.get("createdAt") or recovered_at)
        adapted_task = adapt_task(task, str(manifest.get("createdAt") or recovered_at), task_created_at)
        if args.map_id:
            adapted_task["map"]["id"] = args.map_id

        parking_points = adapted_task["parkingPoints"]
        poses = [pose for parking in parking_points for pose in parking["poses"]]
        if len(parking_points) != int(binding.get("task", {}).get("parkingPointCount", -1)):
            raise ValueError("恢复后的停车点数量不一致")
        if len(poses) != int(binding.get("task", {}).get("poseCount", -1)):
            raise ValueError("恢复后的姿态数量不一致")
        if not poses:
            raise ValueError("Server 计算包内没有可恢复的示教姿态")

        active_parking = parking_points[-1]
        active_pose = active_parking["poses"][-1]
        bounds = environment["bounds"]
        center = {
            axis: (float(bounds["min"][axis]) + float(bounds["max"][axis])) / 2
            for axis in "xyz"
        }
        radius = math.sqrt(sum(
            ((float(bounds["max"][axis]) - float(bounds["min"][axis])) / 2) ** 2
            for axis in "xyz"
        ))
        map_modified_at = file_time(map_path)
        map_descriptor = {
            "fileName": map_path.name,
            "format": "ply",
            "byteLength": source_size,
            "fileModifiedAt": map_modified_at,
            "mimeType": "application/octet-stream",
            "loadedAt": args.map_loaded_at or None,
            "sourceKind": "recovered-server-job",
            "pointCount": point_count,
            "faceCount": triangle_count,
            "bounds": bounds,
            "sourceHash": source_hash,
            "sourceHashKind": "file",
        }
        map_metadata = {
            "schemaVersion": 1,
            "storage": "atlas-geometry-cache",
            "coordinateFrame": "map",
            "coordinateSystem": "right-handed-z-up",
            "name": map_path.name,
            "original": {
                "format": "ply",
                "byteLength": source_size,
                "fileModifiedAt": map_modified_at,
                "mimeType": "application/octet-stream",
                "sourceHash": source_hash,
                "sourceHashKind": "file",
            },
            "geometry": {
                "geometryCacheVersion": 1,
                "pointCount": point_count,
                "faceCount": triangle_count,
                "bounds": bounds,
                "sphere": {"center": center, "radius": radius},
                "positions": {
                    "file": MAP_POSITIONS_FILE,
                    "encoding": "float32-le",
                    "components": 3,
                },
                "colors": {
                    "file": MAP_COLORS_FILE,
                    "encoding": "rgb8",
                    "components": 3,
                },
                "triangles": {
                    "file": MAP_TRIANGLES_FILE,
                    "encoding": "uint32-le",
                    "components": 3,
                },
            },
        }

        robot_file_metadata = []
        for relative, local_path in robot_files:
            robot_file_metadata.append({
                "path": relative,
                "archivePath": f"robot/files/{relative}",
                "mimeType": MIME_TYPES.get(local_path.suffix.lower(), "application/octet-stream"),
                "byteLength": local_path.stat().st_size,
            })
        package_name = PurePosixPath(robot_relative_path).parts[0]
        robot_metadata = {
            "schemaVersion": 1,
            "storage": "atlas-portable-robot-package",
            "id": robot_relative_path,
            "name": str(task.get("robot", {}).get("name") or package_name),
            "relativePath": robot_relative_path,
            "format": "urdf",
            "packageName": package_name,
            "packagePath": package_name,
            "files": robot_file_metadata,
        }

        first_mismatch = None
        for parking in parking_points:
            for pose in parking["poses"]:
                distance = pose_distance(parking["mapPose"], pose["mapPose"])
                if distance > 0.001:
                    first_mismatch = {
                        "parkingPointId": parking["id"],
                        "parkingPointName": parking["name"],
                        "distanceMeters": distance,
                        "handling": "kept-source-values",
                    }
                    break
            if first_mismatch:
                break

        recovery_report = {
            "schemaVersion": 1,
            "recoveredAt": recovered_at,
            "source": {
                "archive": source_path.name,
                "format": manifest.get("format"),
                "jobId": manifest.get("jobId"),
                "createdAt": manifest.get("createdAt"),
                "taskDigest": expected_task_digest,
            },
            "integrity": {
                "serverManifest": "verified",
                "mapSha256": source_hash,
                "robotUrdfSha256": primary_hash,
                "identityBinding": "verified",
            },
            "recovered": {
                "taskId": adapted_task["id"],
                "taskName": adapted_task["name"],
                "parkingPointCount": len(parking_points),
                "poseCount": len(poses),
                "jointValueCounts": [pose["fullBodyJoints"]["count"] for pose in poses],
                "opticalTargetCounts": [len(pose["opticalTargets"]) for pose in poses],
                "mapPoints": point_count,
                "mapTriangles": triangle_count,
                "mapColors": len(colors) // 3,
                "robotResourceCount": len(robot_files),
            },
            "adaptations": [
                "Converted parking points and poses to schema 1.3 virtualTeaching hierarchy.",
                "Converted jointValues to fullBodyJoints while preserving all joint names and values.",
                "Preserved left/right opticalTargets for future Server merge planning.",
                "Embedded exact map mesh, source colors, and complete browser robot resources.",
                "Selected the last recovered parking point and pose as the current robot state.",
            ],
            "limitations": [
                "The Server job intentionally contains no RGB or camera point-cloud snapshots.",
                "The browser's historical external blob payloads were no longer present, so camera media cannot be reconstructed from this source.",
                "Exact pose capture times were not stored in the Server job and remain blank.",
                "Navigation waypoints and paths were not part of the Server job; the last inline browser snapshot showed both collections empty.",
            ],
            "dataQualityWarnings": [first_mismatch] if first_mismatch else [],
            "parkingPoints": [
                {
                    "id": parking["id"],
                    "name": parking["name"],
                    "mapPose": parking["mapPose"],
                    "poseCount": len(parking["poses"]),
                    "poseIds": [pose["id"] for pose in parking["poses"]],
                }
                for parking in parking_points
            ],
        }

        project = {
            "schemaVersion": "1.3",
            "exportedAt": recovered_at,
            "coordinateSystem": {
                "horizontalPlane": "XY",
                "verticalAxis": "Z",
                "angleUnit": "degree",
                "distanceUnit": "meter",
            },
            "rendering": {"meshQuality": "balanced"},
            "workspace": {
                "pointColorMode": "source",
                "showWaypoints3D": True,
                "activeTeachingTaskId": adapted_task["id"],
                "activeTeachingParkingPointId": active_parking["id"],
                "collapsedPanel": None,
                "inspectorCollapsed": False,
            },
            "map": map_descriptor,
            "projection": {
                "plane": "XY",
                "mode": "height-range",
                "verticalAxis": "Z",
                "minHeight": args.slice_min,
                "maxHeight": args.slice_max,
                "centerHeight": (args.slice_min + args.slice_max) / 2,
                "heightSpan": args.slice_max - args.slice_min,
            },
            "view2d": {
                "centerX": args.view2d_center_x,
                "centerY": args.view2d_center_y,
                "scale": args.view2d_scale,
            },
            "view3d": {
                "version": 1,
                "position": {"x": 0.1582123653908052, "y": -12.621038721943266, "z": 1.6421839179889905},
                "target": {"x": 0.6014699999570858, "y": -8.735641839745899, "z": 0.7086166500012023},
                "up": {"x": 0.05199394716907775, "y": -0.2045478716191948, "z": 0.9774747043652008},
                "zoom": 1,
                "projectionOffset": {"x": 0, "y": 0},
            },
            "robot": {
                "id": robot_relative_path,
                "name": robot_metadata["name"],
                "fileName": PurePosixPath(robot_relative_path).name,
                "relativePath": robot_relative_path,
                "format": "urdf",
                "packageName": package_name,
                "packagePath": package_name,
                "manifestUrl": None,
                "joints": copy.deepcopy(active_pose["fullBodyJoints"]["values"]),
                "lockedJoints": [
                    "waist_yaw_J", "waist_pitch_J", "knee_pitch_J", "ankle_pitch_J"
                ],
                "origin": copy.deepcopy(active_pose["mapPose"]),
            },
            "virtualTeaching": {
                "coordinateFrame": "map",
                "angularUnit": "degree",
                "distanceUnit": "meter",
                "jointPoses": [],
                "tasks": [adapted_task],
            },
            "waypoints": [],
            "paths": [],
            "recovery": {
                "status": "recovered-from-server-job",
                "reportFile": "recovery/recovery-report.json",
                "sourceJobId": manifest.get("jobId"),
                "sourceTaskDigest": expected_task_digest,
            },
            "archive": {
                "format": PROJECT_FORMAT,
                "version": PROJECT_ARCHIVE_VERSION,
                "manifestFile": MANIFEST_FILE,
                "projectFile": PROJECT_FILE,
                "mediaStorage": "external-files",
                "resourceStorage": "embedded",
                "resources": {
                    "environment": {
                        "metadataFile": MAP_META_FILE,
                        "positionsFile": MAP_POSITIONS_FILE,
                        "colorsFile": MAP_COLORS_FILE,
                        "trianglesFile": MAP_TRIANGLES_FILE,
                    },
                    "robot": {"metadataFile": ROBOT_META_FILE, "root": "robot/files/"},
                },
            },
        }

        output_path.parent.mkdir(parents=True, exist_ok=True)
        partial_path = output_path.with_name(f".{output_path.name}.partial")
        if partial_path.exists():
            partial_path.unlink()
        try:
            with zipfile.ZipFile(partial_path, "w", allowZip64=True) as target:
                writer = ArchiveWriter(target)
                writer.write_bytes(MAP_META_FILE, json_bytes(map_metadata), "environment-metadata")
                for path, role in (
                    ("environment/positions.f32le", "environment-geometry"),
                    ("environment/triangles.u32le", "environment-geometry"),
                ):
                    with source.open(path) as stream:
                        record = writer.write_stream(path, stream, role, 1)
                    expected = point_count * 12 if "positions" in path else triangle_count * 12
                    if record["byteLength"] != expected:
                        raise ValueError(f"Server 地图几何长度异常：{path}")
                writer.write_bytes(MAP_COLORS_FILE, colors, "environment-geometry", 1)
                del colors

                writer.write_bytes(ROBOT_META_FILE, json_bytes(robot_metadata), "robot-metadata")
                for index, (relative, local_path) in enumerate(robot_files, 1):
                    level = 0 if local_path.suffix.lower() in (".glb", ".png", ".jpg", ".jpeg") else 1
                    writer.write_file(
                        f"robot/files/{relative}", local_path, role_for_robot(relative), level
                    )
                    progress(index, len(robot_files), f"打包机器人资源 · {relative}")

                for parking_index, parking in enumerate(parking_points):
                    task_folder = f"01_{sanitize_segment(adapted_task['name'], 'task')}"
                    parking_folder = (
                        f"{parking_index + 1:02d}_{sanitize_segment(parking['name'], 'parking-point')}"
                    )
                    for pose_index, pose in enumerate(parking["poses"]):
                        pose_folder = f"{pose_index + 1:02d}_{sanitize_segment(pose['name'], 'pose')}"
                        pose_path = (
                            f"teaching-data/{task_folder}/{parking_folder}/{pose_folder}/pose.json"
                        )
                        writer.write_bytes(pose_path, json_bytes({
                            "schemaVersion": 1,
                            "recordType": "teaching-pose",
                            "task": {"id": adapted_task["id"], "name": adapted_task["name"]},
                            "parkingPoint": {
                                "id": parking["id"],
                                "name": parking["name"],
                                "sequence": parking["sequence"],
                            },
                            "pose": pose,
                        }), "teaching-metadata")

                writer.write_bytes(
                    "recovery/source-task.json", json_bytes(task), "recovery-source"
                )
                writer.write_bytes(
                    "recovery/server-config.json", json_bytes(server_config), "recovery-source"
                )
                writer.write_bytes(
                    "recovery/recovery-report.json", json_bytes(recovery_report), "recovery-report"
                )
                project_body = json_bytes(project)
                writer.write_bytes(PROJECT_FILE, project_body, "project-config")
                writer.write_bytes("README.txt", (
                    "虚拟示教平台 · 恢复工程\n\n"
                    "该工程由已校验的停车点 Server 计算包恢复。\n"
                    "在网页中点击“加载工程”，选择本 ZIP，即可恢复地图、机器人、视角与示教任务。\n"
                    "恢复明细与限制：recovery/recovery-report.json\n"
                    "原始计算任务：recovery/source-task.json\n\n"
                    "注意：Server 计算包不包含相机 RGB/点云媒体，因此本工程只保留相机光学目标位姿。\n"
                ).encode("utf-8"), "instructions")

                records = sorted(writer.records, key=lambda item: item["path"])
                environment_records = [
                    {key: record[key] for key in ("path", "byteLength", "sha256")}
                    for record in records if record["path"].startswith("environment/")
                ]
                robot_records = [
                    {key: record[key] for key in ("path", "byteLength", "sha256")}
                    for record in records if record["path"].startswith("robot/files/")
                ]
                manifest_out = {
                    "format": PROJECT_FORMAT,
                    "archiveVersion": PROJECT_ARCHIVE_VERSION,
                    "schemaVersion": project["schemaVersion"],
                    "exportedAt": recovered_at,
                    "projectFile": PROJECT_FILE,
                    "portable": True,
                    "layout": {
                        "environment": "environment/{map.json,positions.f32le,colors.rgb8,triangles.*}",
                        "robot": "robot/{robot.json,files/**}",
                        "teaching": "teaching-data/<task>/<parking-point>/<pose>/{pose.json,rgb,pointcloud}",
                    },
                    "identities": {
                        "map": {
                            "fileName": map_path.name,
                            "sourceHash": source_hash,
                            "sourceHashKind": "file",
                            "geometryDigest": hashlib.sha256(
                                stable_json_bytes(environment_records)
                            ).hexdigest(),
                        },
                        "robot": {
                            "id": robot_relative_path,
                            "relativePath": robot_relative_path,
                            "packageName": package_name,
                            "resourceDigest": hashlib.sha256(
                                stable_json_bytes(robot_records)
                            ).hexdigest(),
                        },
                    },
                    "files": records,
                    "statistics": {
                        "taskCount": 1,
                        "parkingPointCount": len(parking_points),
                        "poseCount": len(poses),
                        "cameraFrameCount": 0,
                        "rgbFileCount": 0,
                        "pointCloudCount": 0,
                        "previewFileCount": 0,
                        "environmentFileCount": len(environment_records),
                        "robotFileCount": len(robot_records) + 1,
                        "assetByteLength": sum(
                            record["byteLength"] for record in records
                            if record["role"] not in ("project-config", "instructions")
                        ),
                        "projectJsonByteLength": len(project_body),
                        "fileCount": len(records) + 1,
                    },
                    "recovery": project["recovery"],
                }
                manifest_body = json_bytes(manifest_out)
                info = zipfile.ZipInfo(MANIFEST_FILE, datetime.now().timetuple()[:6])
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                info._compresslevel = 6
                target.writestr(info, manifest_body)
            os.replace(partial_path, output_path)
        except Exception:
            if partial_path.exists():
                partial_path.unlink()
            raise

    return output_path, recovery_report


def parse_args():
    parser = argparse.ArgumentParser(
        description="将停车点 Server 计算包恢复为当前网页可加载的便携工程 ZIP"
    )
    parser.add_argument("--input", type=Path, required=True, help="Server 计算包 ZIP")
    parser.add_argument("--map", type=Path, required=True, help="与计算包哈希一致的原始 PLY")
    parser.add_argument("--robots-dir", type=Path, default=Path("robots"), help="机器人资源根目录")
    parser.add_argument("--output", type=Path, required=True, help="输出便携工程 ZIP")
    parser.add_argument("--task-created-at", default="", help="从历史记录恢复的任务创建时间")
    parser.add_argument("--map-loaded-at", default="", help="从历史记录恢复的地图加载时间")
    parser.add_argument("--map-id", default="", help="从历史记录恢复的地图 ID")
    parser.add_argument("--slice-min", type=float, default=0.020358460023999214)
    parser.add_argument("--slice-max", type=float, default=12.3216552734375)
    parser.add_argument("--view2d-center-x", type=float, default=5.259043894228636)
    parser.add_argument("--view2d-center-y", type=float, default=-0.6622355963961857)
    parser.add_argument("--view2d-scale", type=float, default=29.363673976926048)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        output, report = build_archive(args)
        digest, size = sha256_file(output)
        print("\n恢复完成")
        print(f"工程包：{output}")
        print(f"大小：{size:,} bytes")
        print(f"SHA-256：{digest}")
        print(
            f"示教数据：{report['recovered']['parkingPointCount']} 个停车点 / "
            f"{report['recovered']['poseCount']} 个姿态"
        )
        return 0
    except Exception as error:
        print(f"恢复失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
