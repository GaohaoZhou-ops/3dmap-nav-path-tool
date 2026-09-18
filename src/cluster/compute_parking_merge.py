#!/usr/bin/env python3
"""Offline Atlas common-parking planner.

The implementation intentionally uses a portable URDF parser and numerical DLS
solver so a job archive remains self-contained and reproducible on a compute
node. Environment collision uses final-pose OBB proxies against a KD-tree built
from the exported map points and triangle centroids. The mobile base is omitted
to match the teaching workbench's ground-noise policy.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
import os
import re
import sys
import threading
import time
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple
from xml.etree import ElementTree as ET

try:
    import numpy as np
    from scipy.spatial import cKDTree
    from scipy.spatial.transform import Rotation
    import trimesh
except ImportError as error:  # pragma: no cover - exercised before environment setup
    raise SystemExit(
        f"Missing compute dependency: {error}. Run 'bash run_cluster.sh' instead."
    ) from error


JOB_FORMAT = "atlas-parking-merge-server-job"
RESULT_FORMAT = "atlas-parking-merge-server-result"
ARCHIVE_VERSION = 1
ALGORITHM_ID = "atlas-common-parking-dls-environment"
ALGORITHM_VERSION = "1.0.0"
CHASSIS_PATTERN = re.compile(
    r"(?:^base(?:[_-]|$)|(?:^|[_-])(?:chassis|wheel|caster|mecanum)(?:[_-]|$)|(?:mobile|robot)[_-]base)",
    re.IGNORECASE,
)


class TerminalProgress:
    """Small dependency-free progress bar that also behaves well in batch logs."""

    BAR_WIDTH = 30
    SPINNER = "|/-\\"
    LOG_HEARTBEAT_SECONDS = 15.0

    def __init__(self) -> None:
        self.is_tty = bool(getattr(sys.stdout, "isatty", lambda: False)())
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._started_at = time.monotonic()
        self._fraction = 0.0
        self._stage = "准备计算"
        self._detail = ""
        self._last_stage = ""
        self._last_log_bucket = -1
        self._last_log_at = self._started_at

    @staticmethod
    def _elapsed_label(seconds: float) -> str:
        elapsed = max(0, int(seconds))
        hours, remainder = divmod(elapsed, 3600)
        minutes, secs = divmod(remainder, 60)
        return f"{hours:02d}:{minutes:02d}:{secs:02d}" if hours else f"{minutes:02d}:{secs:02d}"

    def _line_locked(self) -> str:
        elapsed = time.monotonic() - self._started_at
        completed = min(self.BAR_WIDTH, int(self._fraction * self.BAR_WIDTH))
        if self._fraction >= 1:
            bar = "=" * self.BAR_WIDTH
        else:
            bar = "=" * completed + ">" + "." * max(0, self.BAR_WIDTH - completed - 1)
        spinner = self.SPINNER[int(elapsed * 4) % len(self.SPINNER)]
        percent = min(100, max(0, round(self._fraction * 100)))
        detail = f" | {self._detail}" if self._detail else ""
        return (
            f"[{bar}] {percent:3d}% {spinner} {self._elapsed_label(elapsed)}"
            f" | {self._stage}{detail}"
        )

    def _emit_tty_locked(self, newline: bool = False) -> None:
        ending = "\n" if newline else ""
        sys.stdout.write(f"\r\033[2K{self._line_locked()}{ending}")
        sys.stdout.flush()

    def _emit_log_locked(self, force: bool = False, heartbeat: bool = False) -> None:
        now = time.monotonic()
        bucket = int(self._fraction * 20)
        stage_changed = self._stage != self._last_stage
        heartbeat_due = heartbeat and now - self._last_log_at >= self.LOG_HEARTBEAT_SECONDS
        if not (force or stage_changed or bucket > self._last_log_bucket or heartbeat_due):
            return
        suffix = " | RUNNING" if heartbeat_due and not (force or stage_changed) else ""
        print(f"{self._line_locked()}{suffix}", flush=True)
        self._last_stage = self._stage
        self._last_log_bucket = max(self._last_log_bucket, bucket)
        self._last_log_at = now

    def _heartbeat(self) -> None:
        interval = 0.25 if self.is_tty else 1.0
        while not self._stop.wait(interval):
            with self._lock:
                if self.is_tty:
                    self._emit_tty_locked()
                else:
                    self._emit_log_locked(heartbeat=True)

    def start(self) -> None:
        with self._lock:
            self._started_at = time.monotonic()
            self._last_log_at = self._started_at
            if self.is_tty:
                self._emit_tty_locked()
            else:
                self._emit_log_locked(force=True)
        self._thread = threading.Thread(
            target=self._heartbeat,
            name="atlas-progress",
            daemon=True,
        )
        self._thread.start()

    def update(self, fraction: float, stage: Optional[str] = None, detail: Optional[str] = None) -> None:
        with self._lock:
            self._fraction = min(1.0, max(self._fraction, finite(fraction)))
            if stage is not None:
                self._stage = str(stage)
            if detail is not None:
                self._detail = str(detail)
            if self.is_tty:
                self._emit_tty_locked()
            else:
                self._emit_log_locked()

    def finish(self, stage: str, detail: str = "") -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1.0)
        with self._lock:
            self._fraction = 1.0
            self._stage = stage
            self._detail = detail
            if self.is_tty:
                self._emit_tty_locked(newline=True)
            else:
                self._emit_log_locked(force=True)

    def fail(self, detail: str) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1.0)
        with self._lock:
            self._stage = "计算失败"
            self._detail = detail
            if self.is_tty:
                self._emit_tty_locked(newline=True)
            else:
                self._emit_log_locked(force=True)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_json(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")


def pretty_json(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def finite(value: object, fallback: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if math.isfinite(result) else fallback


def normalized_angle(value: float) -> float:
    result = (finite(value) + 180.0) % 360.0 - 180.0
    return 0.0 if abs(result) < 1e-10 else result


def pose_matrix(pose: dict) -> np.ndarray:
    position = pose.get("position", {})
    rpy = pose.get("rpy", {})
    roll, pitch, yaw = np.radians(
        [finite(rpy.get("roll")), finite(rpy.get("pitch")), finite(rpy.get("yaw"))]
    )
    cr, sr = math.cos(roll), math.sin(roll)
    cp, sp = math.cos(pitch), math.sin(pitch)
    cy, sy = math.cos(yaw), math.sin(yaw)
    rotation = np.array(
        [
            [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
            [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
            [-sp, cp * sr, cp * cr],
        ],
        dtype=np.float64,
    )
    matrix = np.eye(4, dtype=np.float64)
    matrix[:3, :3] = rotation
    matrix[:3, 3] = [
        finite(position.get("x")),
        finite(position.get("y")),
        finite(position.get("z")),
    ]
    return matrix


def xyz_rpy_matrix(xyz: Sequence[float], rpy: Sequence[float]) -> np.ndarray:
    matrix = pose_matrix(
        {
            "position": {"x": xyz[0], "y": xyz[1], "z": xyz[2]},
            "rpy": {
                "roll": math.degrees(rpy[0]),
                "pitch": math.degrees(rpy[1]),
                "yaw": math.degrees(rpy[2]),
            },
        }
    )
    return matrix


def parse_vector(raw: Optional[str], count: int, fallback: Sequence[float]) -> np.ndarray:
    try:
        values = [float(item) for item in str(raw or "").split()]
    except ValueError:
        values = []
    return np.asarray(values if len(values) == count else fallback, dtype=np.float64)


def origin_matrix(node: Optional[ET.Element]) -> np.ndarray:
    if node is None:
        return np.eye(4, dtype=np.float64)
    return xyz_rpy_matrix(
        parse_vector(node.get("xyz"), 3, (0, 0, 0)),
        parse_vector(node.get("rpy"), 3, (0, 0, 0)),
    )


def rotation_about_axis(axis: np.ndarray, angle: float) -> np.ndarray:
    matrix = np.eye(4, dtype=np.float64)
    matrix[:3, :3] = Rotation.from_rotvec(axis * angle).as_matrix()
    return matrix


@dataclass
class Joint:
    name: str
    kind: str
    parent: str
    child: str
    origin: np.ndarray
    axis: np.ndarray
    lower: float
    upper: float

    @property
    def movable(self) -> bool:
        return self.kind in {"revolute", "continuous", "prismatic"}

    def clamp(self, value: float) -> float:
        return min(self.upper, max(self.lower, value))


@dataclass
class CollisionProxy:
    link: str
    origin: np.ndarray
    local_center: np.ndarray
    half_size: np.ndarray


class RobotModel:
    def __init__(
        self,
        urdf_path: Path,
        job_root: Path,
        progress: Optional[TerminalProgress] = None,
    ):
        self.job_root = job_root
        progress and progress.update(0.11, "读取机器人模型", urdf_path.name)
        root = ET.parse(urdf_path).getroot()
        self.links = [node.get("name", "") for node in root.findall("link")]
        self.joints: List[Joint] = []
        self.child_joint: Dict[str, Joint] = {}
        child_links = set()
        for node in root.findall("joint"):
            parent = node.find("parent")
            child = node.find("child")
            if parent is None or child is None:
                continue
            kind = node.get("type", "fixed")
            axis = parse_vector(node.find("axis").get("xyz") if node.find("axis") is not None else None, 3, (0, 0, 1))
            norm = np.linalg.norm(axis)
            axis = axis / norm if norm > 1e-12 else np.array([0.0, 0.0, 1.0])
            limit = node.find("limit")
            lower = finite(limit.get("lower"), -math.inf) if limit is not None else -math.inf
            upper = finite(limit.get("upper"), math.inf) if limit is not None else math.inf
            if kind == "continuous":
                lower, upper = -math.inf, math.inf
            joint = Joint(
                name=node.get("name", f"joint-{len(self.joints)}"),
                kind=kind,
                parent=parent.get("link", ""),
                child=child.get("link", ""),
                origin=origin_matrix(node.find("origin")),
                axis=axis,
                lower=lower,
                upper=upper,
            )
            self.joints.append(joint)
            self.child_joint[joint.child] = joint
            child_links.add(joint.child)
        self.root_link = next((name for name in self.links if name not in child_links), self.links[0])
        self.movable = {joint.name: joint for joint in self.joints if joint.movable}
        self.proxies = self._read_collision_proxies(root, progress)
        progress and progress.update(
            0.25,
            "机器人模型就绪",
            f"{len(self.movable)} 个活动关节 / {len(self.proxies)} 个碰撞体",
        )

    def _mesh_path(self, filename: str) -> Optional[Path]:
        package = re.match(r"^package://([^/]+)/(.+)$", filename, re.IGNORECASE)
        if package:
            return self.job_root / "robot" / package.group(1) / package.group(2)
        return None

    def _mesh_bounds(self, mesh: ET.Element) -> Optional[Tuple[np.ndarray, np.ndarray]]:
        source = self._mesh_path(mesh.get("filename", ""))
        if not source or not source.is_file():
            return None
        loaded = trimesh.load(source, force="mesh", process=False)
        if not hasattr(loaded, "bounds") or loaded.bounds is None:
            return None
        scale = parse_vector(mesh.get("scale"), 3, (1, 1, 1))
        scaled_min = loaded.bounds[0] * scale
        scaled_max = loaded.bounds[1] * scale
        lower = np.minimum(scaled_min, scaled_max)
        upper = np.maximum(scaled_min, scaled_max)
        return (lower + upper) * 0.5, np.maximum((upper - lower) * 0.5, 0.0005)

    def _read_collision_proxies(
        self,
        root: ET.Element,
        progress: Optional[TerminalProgress] = None,
    ) -> List[CollisionProxy]:
        proxies: List[CollisionProxy] = []
        links = [
            link for link in root.findall("link")
            if not CHASSIS_PATTERN.search(link.get("name", ""))
        ]
        collision_total = sum(len(link.findall("collision")) for link in links)
        collision_index = 0
        for link in links:
            name = link.get("name", "")
            for collision in link.findall("collision"):
                progress and progress.update(
                    0.12 + 0.12 * collision_index / max(1, collision_total),
                    "读取机器人碰撞模型",
                    f"{collision_index + 1}/{collision_total} · {name}",
                )
                geometry = collision.find("geometry")
                if geometry is None:
                    collision_index += 1
                    continue
                local_center = np.zeros(3, dtype=np.float64)
                half_size = None
                box = geometry.find("box")
                sphere = geometry.find("sphere")
                cylinder = geometry.find("cylinder")
                mesh = geometry.find("mesh")
                if box is not None:
                    half_size = np.abs(parse_vector(box.get("size"), 3, (0, 0, 0))) * 0.5
                elif sphere is not None:
                    radius = abs(finite(sphere.get("radius")))
                    half_size = np.repeat(radius, 3)
                elif cylinder is not None:
                    radius = abs(finite(cylinder.get("radius")))
                    half_size = np.array([radius, radius, abs(finite(cylinder.get("length"))) * 0.5])
                elif mesh is not None:
                    bounds = self._mesh_bounds(mesh)
                    if bounds is not None:
                        local_center, half_size = bounds
                if half_size is not None and np.all(np.isfinite(half_size)):
                    proxies.append(CollisionProxy(
                        name,
                        origin_matrix(collision.find("origin")),
                        local_center,
                        np.maximum(half_size, 0.0005),
                    ))
                collision_index += 1
        return proxies

    def serialized_to_internal(self, values: dict) -> Dict[str, float]:
        result = {}
        for name, joint in self.movable.items():
            value = finite(values.get(name))
            result[name] = value if joint.kind == "prismatic" else math.radians(value)
        return result

    def internal_to_serialized(self, values: Dict[str, float]) -> Dict[str, float]:
        return {
            name: (value if self.movable[name].kind == "prismatic" else math.degrees(value))
            for name, value in sorted(values.items()) if name in self.movable
        }

    def forward(self, base_pose: dict, values: Dict[str, float]) -> Dict[str, np.ndarray]:
        transforms = {self.root_link: pose_matrix(base_pose)}
        unresolved = list(self.joints)
        while unresolved:
            progress = False
            for joint in unresolved[:]:
                parent = transforms.get(joint.parent)
                if parent is None:
                    continue
                motion = np.eye(4, dtype=np.float64)
                value = joint.clamp(finite(values.get(joint.name)))
                if joint.kind in {"revolute", "continuous"}:
                    motion = rotation_about_axis(joint.axis, value)
                elif joint.kind == "prismatic":
                    motion[:3, 3] = joint.axis * value
                transforms[joint.child] = parent @ joint.origin @ motion
                unresolved.remove(joint)
                progress = True
            if not progress:
                raise RuntimeError("URDF joint graph is disconnected or cyclic")
        return transforms

    def chain(self, frame_name: str) -> List[Joint]:
        chain: List[Joint] = []
        link = frame_name
        visited = set()
        while link in self.child_joint and link not in visited:
            visited.add(link)
            joint = self.child_joint[link]
            if joint.movable:
                chain.append(joint)
            link = joint.parent
        chain.reverse()
        return chain


def quaternion_matrix(value: dict) -> np.ndarray:
    quaternion = np.array(
        [finite(value.get(axis)) for axis in ("x", "y", "z", "w")], dtype=np.float64
    )
    norm = np.linalg.norm(quaternion)
    if norm < 1e-12:
        raise ValueError("target quaternion has zero length")
    return Rotation.from_quat(quaternion / norm).as_matrix()


def target_from_transform(side: str, frame_name: str, transform: np.ndarray, source: str) -> dict:
    quaternion = Rotation.from_matrix(transform[:3, :3]).as_quat()
    return {
        "side": side,
        "frameName": frame_name,
        "source": source,
        "position": transform[:3, 3].copy(),
        "rotation": transform[:3, :3].copy(),
        "quaternion": quaternion,
    }


def target_from_record(side: str, record: dict) -> dict:
    return {
        "side": side,
        "frameName": record.get("frameName") or f"zivid_{side}_optical_frame",
        "source": "camera-capture",
        "position": np.array([finite(record.get("position", {}).get(axis)) for axis in ("x", "y", "z")]),
        "rotation": quaternion_matrix(record.get("quaternion", {})),
    }


def pose_error(current: np.ndarray, target: dict) -> Tuple[np.ndarray, np.ndarray]:
    position = target["position"] - current[:3, 3]
    rotation = Rotation.from_matrix(target["rotation"] @ current[:3, :3].T).as_rotvec()
    return position, rotation


def solve_ik(model: RobotModel, base_pose: dict, values: Dict[str, float], target: dict, config: dict) -> Dict[str, float]:
    frame_name = target["frameName"]
    joints = model.chain(frame_name)
    if not joints:
        return values
    maximum_iterations = int(config.get("maximumIterations", 28))
    damping = finite(config.get("damping"), 0.045)
    orientation_scale = finite(config.get("orientationScale"), 0.24)
    current_values = dict(values)
    for _ in range(maximum_iterations):
        transforms = model.forward(base_pose, current_values)
        frame = transforms.get(frame_name)
        if frame is None:
            break
        position_error, rotation_error = pose_error(frame, target)
        if np.linalg.norm(position_error) < 0.00045 and np.linalg.norm(rotation_error) < math.radians(0.18):
            break
        jacobian = np.zeros((6, len(joints)), dtype=np.float64)
        for index, joint in enumerate(joints):
            epsilon = 1e-5
            perturbed = dict(current_values)
            perturbed[joint.name] = joint.clamp(perturbed.get(joint.name, 0.0) + epsilon)
            delta = perturbed[joint.name] - current_values.get(joint.name, 0.0)
            if abs(delta) < 1e-12:
                continue
            moved = model.forward(base_pose, perturbed)[frame_name]
            jacobian[:3, index] = (moved[:3, 3] - frame[:3, 3]) / delta
            jacobian[3:, index] = Rotation.from_matrix(moved[:3, :3] @ frame[:3, :3].T).as_rotvec() / delta * orientation_scale
        error = np.concatenate((position_error, rotation_error * orientation_scale))
        normal = jacobian @ jacobian.T + np.eye(6) * damping * damping
        try:
            resolved = np.linalg.solve(normal, error)
        except np.linalg.LinAlgError:
            break
        steps = np.clip(jacobian.T @ resolved * 0.76, -0.13, 0.13)
        if not np.any(np.abs(steps) > 1e-7):
            break
        for joint, step in zip(joints, steps):
            current_values[joint.name] = joint.clamp(current_values.get(joint.name, 0.0) + float(step))
    return current_values


class EnvironmentCollision:
    def __init__(
        self,
        job_root: Path,
        metadata: dict,
        enabled: bool,
        progress: Optional[TerminalProgress] = None,
    ):
        self.enabled = enabled
        self.safety = 0.1
        self.margin = 0.008
        self.points = np.empty((0, 3), dtype=np.float32)
        self.tree = None
        if not enabled:
            progress and progress.update(0.40, "环境碰撞索引", "已按参数关闭")
            return
        geometry = metadata.get("geometry", {})
        position_path = job_root / geometry["positionFile"]
        progress and progress.update(
            0.27,
            "读取环境几何",
            f"{int(geometry.get('pointCount', 0)):,} 个顶点",
        )
        self.points = np.fromfile(position_path, dtype="<f4").reshape((-1, 3))
        triangle_file = geometry.get("triangleFile")
        if triangle_file:
            progress and progress.update(
                0.31,
                "读取环境网格",
                f"{int(geometry.get('triangleCount', 0)):,} 个三角面",
            )
            triangles = np.fromfile(job_root / triangle_file, dtype="<u4").reshape((-1, 3))
            valid = triangles[np.all(triangles < len(self.points), axis=1)]
            if len(valid) > 360_000:
                selected = np.linspace(0, len(valid) - 1, 360_000, dtype=np.int64)
                valid = valid[selected]
            if len(valid):
                centroids = self.points[valid].mean(axis=1, dtype=np.float32)
                self.points = np.concatenate((self.points, centroids), axis=0)
        progress and progress.update(
            0.35,
            "构建环境空间索引",
            f"{len(self.points):,} 个碰撞采样点",
        )
        self.tree = cKDTree(self.points)
        progress and progress.update(0.40, "环境空间索引就绪", f"{len(self.points):,} 个采样点")

    def configure(self, config: dict) -> None:
        self.safety = max(0.01, finite(config.get("safetyDistance"), 0.1))
        self.margin = max(0.0, finite(config.get("contactMargin"), 0.008))

    def check(self, model: RobotModel, transforms: Dict[str, np.ndarray]) -> dict:
        if not self.enabled or self.tree is None:
            return {"state": "not-checked", "minimumDistance": None, "collisionLinks": [], "nearLinks": []}
        link_distances: Dict[str, float] = {}
        for proxy in model.proxies:
            link_transform = transforms.get(proxy.link)
            if link_transform is None:
                continue
            world = link_transform @ proxy.origin
            center = world[:3, :3] @ proxy.local_center + world[:3, 3]
            rotation = world[:3, :3]
            radius = float(np.linalg.norm(proxy.half_size) + self.safety)
            indices = self.tree.query_ball_point(center, radius)
            if not indices:
                distance = math.inf
            else:
                local = (self.points[np.asarray(indices)] - center) @ rotation
                outside = np.maximum(np.abs(local) - proxy.half_size, 0.0)
                distance = float(np.min(np.linalg.norm(outside, axis=1)))
            link_distances[proxy.link] = min(link_distances.get(proxy.link, math.inf), distance)
        finite_distances = [value for value in link_distances.values() if math.isfinite(value)]
        minimum = min(finite_distances) if finite_distances else None
        collision_links = sorted(name for name, value in link_distances.items() if value <= self.margin)
        near_links = sorted(name for name, value in link_distances.items() if self.margin < value < self.safety)
        return {
            "state": "collision" if collision_links else "near" if near_links else "safe",
            "minimumDistance": minimum,
            "collisionLinks": collision_links,
            "nearLinks": near_links,
        }


def planar_distance(left: dict, right: dict) -> float:
    lp, rp = left["mapPose"]["position"], right["mapPose"]["position"]
    return math.hypot(finite(lp.get("x")) - finite(rp.get("x")), finite(lp.get("y")) - finite(rp.get("y")))


def cluster_parking_points(points: List[dict], threshold: float) -> Tuple[List[dict], List[dict], List[str]]:
    parents = list(range(len(points)))

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(left: int, right: int) -> None:
        a, b = find(left), find(right)
        if a != b:
            parents[b] = a

    pairs = []
    for left in range(len(points)):
        for right in range(left + 1, len(points)):
            distance = planar_distance(points[left], points[right])
            if distance <= threshold:
                union(left, right)
                pairs.append({"leftId": points[left]["id"], "rightId": points[right]["id"], "distance": distance})
    grouped: Dict[int, List[dict]] = {}
    for index, point in enumerate(points):
        grouped.setdefault(find(index), []).append(point)
    clusters, isolated = [], []
    for members in grouped.values():
        if len(members) < 2:
            isolated.append(members[0]["id"])
            continue
        distances = [planar_distance(members[a], members[b]) for a in range(len(members)) for b in range(a + 1, len(members))]
        member_ids = [item["id"] for item in members]
        clusters.append({
            "id": "parking-cluster:" + "|".join(member_ids),
            "members": members,
            "memberIds": member_ids,
            "memberNames": [item["name"] for item in members],
            "maximumPairDistance": max(distances, default=0.0),
            "nearbyPairCount": sum(1 for pair in pairs if pair["leftId"] in member_ids and pair["rightId"] in member_ids),
        })
    return clusters, pairs, isolated


def circular_mean(values: Iterable[float]) -> float:
    radians = [math.radians(finite(value)) for value in values]
    x, y = sum(math.cos(value) for value in radians), sum(math.sin(value) for value in radians)
    return normalized_angle(math.degrees(math.atan2(y, x))) if math.hypot(x, y) > 1e-7 else 0.0


def average_pose(members: List[dict]) -> dict:
    return {
        "frameId": str(members[0].get("mapPose", {}).get("frameId") or "map"),
        "position": {axis: sum(finite(item["mapPose"]["position"].get(axis)) for item in members) / len(members) for axis in ("x", "y", "z")},
        "rpy": {axis: circular_mean(item["mapPose"]["rpy"].get(axis) for item in members) for axis in ("roll", "pitch", "yaw")},
    }


def candidate_travel(pose: dict, members: List[dict]) -> dict:
    virtual = {"mapPose": pose}
    distances = [planar_distance(virtual, member) for member in members]
    return {"maximum": max(distances, default=0.0), "mean": sum(distances) / len(distances) if distances else 0.0}


def common_candidates(members: List[dict]) -> List[dict]:
    def medoid_score(candidate: dict) -> float:
        return sum(planar_distance(candidate, other) + abs(normalized_angle(candidate["mapPose"]["rpy"].get("yaw") - other["mapPose"]["rpy"].get("yaw"))) * 0.003 for other in members)

    anchor = min(members, key=medoid_score)
    candidates = [{
        "id": "cluster-centroid", "source": "centroid", "sourceLabel": "聚类几何中心",
        "anchorParkingPointId": anchor["id"], "anchorParkingPointName": anchor["name"], "mapPose": average_pose(members),
    }]
    candidates.extend({
        "id": f"existing:{item['id']}", "source": "existing", "sourceLabel": f"现有位置 · {item['name']}",
        "anchorParkingPointId": item["id"], "anchorParkingPointName": item["name"], "mapPose": item["mapPose"],
    } for item in members)
    unique = {}
    for candidate in candidates:
        values = list(candidate["mapPose"]["position"].values()) + list(candidate["mapPose"]["rpy"].values())
        signature = "|".join(f"{finite(value):.7f}" for value in values)
        if signature not in unique:
            candidate["travel"] = candidate_travel(candidate["mapPose"], members)
            unique[signature] = candidate
    return list(unique.values())


def maximum_or_zero(values: Iterable[float]) -> float:
    clean = [finite(value, 1e9) for value in values]
    return max(clean, default=0.0)


def analyze(
    job_root: Path,
    manifest: dict,
    task: dict,
    config: dict,
    skip_collision: bool,
    workers: int,
    progress: TerminalProgress,
) -> dict:
    robot_file = job_root / manifest["binding"]["robot"]["primaryFile"]
    model = RobotModel(robot_file, job_root, progress)
    environment_meta = read_json(job_root / manifest["environmentFile"])
    collision_config = config.get("environmentCollision", {})
    collision = EnvironmentCollision(
        job_root,
        environment_meta,
        bool(collision_config.get("enabled", True)) and not skip_collision,
        progress,
    )
    collision.configure(collision_config)
    threshold = max(0.02, finite(config.get("distanceThreshold"), 0.35))
    position_tolerance = max(0.001, finite(config.get("positionTolerance"), 0.05))
    rotation_tolerance = max(0.1, finite(config.get("rotationTolerance"), 5.0))
    parking_points = task.get("parkingPoints", [])
    progress.update(0.41, "聚类停车点", f"{len(parking_points)} 个停车点")
    clusters, nearby_pairs, isolated = cluster_parking_points(parking_points, threshold)
    progress.update(
        0.44,
        "停车点聚类完成",
        f"{len(clusters)} 个近邻簇 / {len(isolated)} 个孤立点",
    )
    plans = []
    prepared_clusters = []
    total_pose_count = sum(
        len(parking.get("poses", []))
        for cluster in clusters
        for parking in cluster["members"]
    )
    prepared_pose_count = 0
    for cluster_index, cluster in enumerate(clusters, 1):
        records = []
        for parking in cluster["members"]:
            for pose in parking.get("poses", []):
                source_pose = pose.get("mapPose") or parking["mapPose"]
                source_values = model.serialized_to_internal(pose.get("jointValues", {}))
                transforms = model.forward(source_pose, source_values)
                targets = []
                for side in ("left", "right"):
                    saved = pose.get("opticalTargets", {}).get(side)
                    frame_name = (saved or {}).get("frameName") or f"zivid_{side}_optical_frame"
                    if saved:
                        targets.append(target_from_record(side, saved))
                    elif frame_name in transforms:
                        targets.append(target_from_transform(side, frame_name, transforms[frame_name], "forward-kinematics"))
                records.append({
                    "poseId": pose["id"], "poseName": pose["name"],
                    "sourceParkingPointId": parking["id"], "sourceParkingPointName": parking["name"],
                    "sourceValues": source_values, "targets": targets,
                })
                prepared_pose_count += 1
                progress.update(
                    0.44 + 0.06 * prepared_pose_count / max(1, total_pose_count),
                    "准备末端约束",
                    f"{prepared_pose_count}/{total_pose_count} · {pose['name']}",
                )
        candidates = common_candidates(cluster["members"])
        prepared_clusters.append((cluster_index, cluster, records, candidates))

    total_planning_units = sum(
        len(candidates) * max(1, len(records))
        for _, _, records, candidates in prepared_clusters
    )
    completed_planning_units = 0
    planning_lock = threading.Lock()

    def advance_planning(detail: str) -> None:
        nonlocal completed_planning_units
        with planning_lock:
            completed_planning_units += 1
            progress.update(
                0.50 + 0.44 * completed_planning_units / max(1, total_planning_units),
                "候选位姿规划",
                f"{completed_planning_units}/{total_planning_units} · {detail}",
            )

    if not prepared_clusters:
        progress.update(0.94, "候选位姿规划", "当前阈值下没有近邻停车点簇")

    for cluster_index, cluster, records, candidates in prepared_clusters:
        def evaluate_candidate(candidate: dict) -> dict:
            planned = []
            for record in records:
                values = dict(record["sourceValues"])
                side_errors = {}
                for _ in range(int(config.get("ik", {}).get("coordinationPasses", 4))):
                    for target in record["targets"]:
                        values = solve_ik(model, candidate["mapPose"], values, target, config.get("ik", {}))
                    transforms = model.forward(candidate["mapPose"], values)
                    side_errors = {}
                    for target in record["targets"]:
                        frame = transforms.get(target["frameName"])
                        if frame is None:
                            side_errors[target["side"]] = {"positionError": 1e9, "rotationError": 1e9, "targetSource": target["source"], "frameName": target["frameName"]}
                            continue
                        position_error, rotation_error = pose_error(frame, target)
                        side_errors[target["side"]] = {
                            "positionError": float(np.linalg.norm(position_error)),
                            "rotationError": math.degrees(float(np.linalg.norm(rotation_error))),
                            "targetSource": target["source"], "frameName": target["frameName"],
                        }
                    if side_errors and all(value["positionError"] <= min(position_tolerance, 0.004) and value["rotationError"] <= min(rotation_tolerance, 1.0) for value in side_errors.values()):
                        break
                transforms = model.forward(candidate["mapPose"], values)
                collision_result = collision.check(model, transforms)
                position_error = maximum_or_zero(item["positionError"] for item in side_errors.values()) if side_errors else 1e9
                rotation_error = maximum_or_zero(item["rotationError"] for item in side_errors.values()) if side_errors else 1e9
                feasible = bool(side_errors) and len(side_errors) == len(record["targets"]) and position_error <= position_tolerance and rotation_error <= rotation_tolerance and collision_result["state"] != "collision"
                planned.append({
                    "poseId": record["poseId"], "poseName": record["poseName"],
                    "sourceParkingPointId": record["sourceParkingPointId"], "sourceParkingPointName": record["sourceParkingPointName"],
                    "feasible": feasible, "positionError": position_error, "rotationError": rotation_error,
                    "sideErrors": side_errors, "jointValues": model.internal_to_serialized(values),
                    "environmentCollision": collision_result,
                })
                advance_planning(
                    f"簇 {cluster_index}/{len(clusters)} · {candidate['sourceLabel']} · {record['poseName']}"
                )
            if not records:
                advance_planning(
                    f"簇 {cluster_index}/{len(clusters)} · {candidate['sourceLabel']} · 无示教姿态"
                )
            feasible_count = sum(1 for item in planned if item["feasible"])
            maximum_position = maximum_or_zero(item["positionError"] for item in planned)
            maximum_rotation = maximum_or_zero(item["rotationError"] for item in planned)
            failed = len(planned) - feasible_count
            score = failed * 1_000_000 + maximum_position / position_tolerance * 1_000 + maximum_rotation / rotation_tolerance * 100 + candidate["travel"]["maximum"]
            return {**candidate, "plannedPoses": planned, "feasiblePoseCount": feasible_count, "failedPoseCount": failed, "maximumPositionError": maximum_position, "maximumRotationError": maximum_rotation, "score": score}

        worker_count = max(1, min(int(workers), len(candidates)))
        if worker_count == 1:
            candidate_results = [evaluate_candidate(candidate) for candidate in candidates]
        else:
            with ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix="atlas-merge") as executor:
                candidate_results = list(executor.map(evaluate_candidate, candidates))
        best = min(candidate_results, key=lambda item: item["score"], default=None)
        feasible = bool(
            best
            and records
            and best["failedPoseCount"] == 0
            and len(best["plannedPoses"]) == len(records)
        )
        plans.append({
            "id": cluster["id"], "memberIds": cluster["memberIds"], "memberNames": cluster["memberNames"],
            "poseCount": len(records), "targetCount": sum(len(item["targets"]) for item in records),
            "maximumPairDistance": cluster["maximumPairDistance"], "nearbyPairCount": cluster["nearbyPairCount"],
            "candidateCount": len(candidates), "feasible": feasible,
            "reason": "" if feasible else "没有候选底盘位姿能同时满足末端容差与环境碰撞约束",
            "candidate": ({key: best[key] for key in ("id", "source", "sourceLabel", "anchorParkingPointId", "anchorParkingPointName", "mapPose", "travel", "maximumPositionError", "maximumRotationError", "feasiblePoseCount", "failedPoseCount")} if best else None),
            "plannedPoses": best["plannedPoses"] if best else [],
        })
        progress.update(
            0.50 + 0.44 * completed_planning_units / max(1, total_planning_units),
            "汇总停车点簇",
            f"{cluster_index}/{len(clusters)} · {'可合并' if feasible else '受阻'}",
        )
    progress.update(0.96, "整理计算结果", f"{len(plans)} 个近邻簇")
    return {
        "version": 1, "status": "ready" if clusters else "no-neighbors", "taskId": task["id"],
        "analyzedAt": utc_now(), "method": "server-xy-single-link+common-base-dual-optical-dls+final-pose-environment-obb",
        "distanceThreshold": threshold, "positionTolerance": position_tolerance, "rotationTolerance": rotation_tolerance,
        "environmentCollision": {"enabled": collision.enabled, "mode": "final-pose-obb", "safetyDistance": collision.safety, "contactMargin": collision.margin},
        "clusters": plans, "nearbyPairs": nearby_pairs, "isolatedParkingPointIds": isolated,
        "feasibleClusterCount": sum(1 for item in plans if item["feasible"]),
    }


def verify_job(job_root: Path, manifest: dict, progress: TerminalProgress) -> None:
    if manifest.get("format") != JOB_FORMAT or manifest.get("archiveVersion") != ARCHIVE_VERSION:
        raise RuntimeError("Unsupported Atlas parking merge job format")
    algorithm = manifest.get("algorithm", {})
    if algorithm.get("id") != ALGORITHM_ID or algorithm.get("version") != ALGORITHM_VERSION:
        raise RuntimeError("Algorithm version mismatch")
    records = manifest.get("files", [])
    for index, record in enumerate(records):
        progress.update(
            0.01 + 0.09 * index / max(1, len(records)),
            "校验计算包",
            f"{index + 1}/{len(records)} · {record['path']}",
        )
        path = job_root / record["path"]
        if not path.is_file():
            raise RuntimeError(f"Manifest resource is missing: {record['path']}")
        if path.stat().st_size != int(record["byteLength"]):
            raise RuntimeError(f"Resource size mismatch: {record['path']}")
        if sha256_file(path) != record["sha256"]:
            raise RuntimeError(f"Resource SHA-256 mismatch: {record['path']}")
    progress.update(0.10, "计算包校验完成", f"{len(records)} 个资源摘要有效")


def write_result(output_dir: Path, manifest: dict, analysis: dict) -> Tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    analysis_bytes = pretty_json(analysis)
    result_manifest = {
        "format": RESULT_FORMAT, "archiveVersion": ARCHIVE_VERSION, "schemaVersion": 1,
        "createdAt": utc_now(),
        "job": {"id": manifest["jobId"], "inputDigest": manifest["inputDigest"]},
        "algorithm": manifest["algorithm"], "binding": manifest["binding"],
        "resultFile": "result/analysis.json", "resultSha256": sha256_bytes(analysis_bytes),
        "summary": {"clusterCount": len(analysis["clusters"]), "feasibleClusterCount": analysis["feasibleClusterCount"]},
    }
    archive_path = output_dir / f"{manifest['jobId']}-result.zip"
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        archive.writestr("manifest.json", pretty_json(result_manifest))
        archive.writestr("result/analysis.json", analysis_bytes)
    json_path = output_dir / f"{manifest['jobId']}-result.json"
    json_path.write_bytes(pretty_json({"manifest": result_manifest, "analysis": analysis}))
    return archive_path, json_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Atlas offline common-parking planner")
    parser.add_argument("--job-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument(
        "--workers",
        type=int,
        default=max(1, min(8, os.cpu_count() or 1)),
        help="parallel candidate workers",
    )
    parser.add_argument("--skip-collision", action="store_true")
    arguments = parser.parse_args()
    job_root = arguments.job_root.resolve()
    output_dir = (arguments.output_dir or job_root / "output").resolve()
    progress = TerminalProgress()
    progress.start()
    try:
        progress.update(0.005, "读取任务清单", str(job_root / "manifest.json"))
        manifest = read_json(job_root / "manifest.json")
        verify_job(job_root, manifest, progress)
        task = read_json(job_root / manifest["taskFile"])
        config = read_json(job_root / manifest["configFile"])
        progress.update(
            0.105,
            "启动停车点规划",
            f"{task['name']} · {max(1, arguments.workers)} workers",
        )
        analysis = analyze(
            job_root,
            manifest,
            task,
            config,
            arguments.skip_collision,
            arguments.workers,
            progress,
        )
        progress.update(0.98, "写出计算结果", str(output_dir))
        archive_path, json_path = write_result(output_dir, manifest, analysis)
        progress.finish(
            "计算完成",
            f"{analysis['feasibleClusterCount']}/{len(analysis['clusters'])} 个近邻簇可合并",
        )
    except Exception as error:
        progress.fail(str(error))
        raise
    print(f"Result ZIP: {archive_path}")
    print(f"Result JSON: {json_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - command-line boundary
        print(f"ERROR: {error}", file=sys.stderr)
        raise
