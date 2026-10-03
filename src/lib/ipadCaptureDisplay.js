import * as THREE from 'three';

export const mobileCaptureMatrix = (task) => Array.isArray(task?.mobileTransform) && task.mobileTransform.length === 16
  ? new THREE.Matrix4().fromArray(task.mobileTransform) : new THREE.Matrix4();

export function mobileSamplePosition(sample, task) {
  const p = sample.cameraPose.position;
  return new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(mobileCaptureMatrix(task));
}

export function createIPadCaptureLayer(tasks) {
  const group = new THREE.Group(); group.name = 'ipad-teaching-captures';
  for (const task of tasks) {
    const samples = task.mobileCapture?.samples;
    if (!samples?.length) continue;
    const lines = [], points = [], targets = [], matrix = mobileCaptureMatrix(task);
    let previous = null;
    for (const sample of samples) {
      const p = sample.cameraPose.position;
      const position = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(matrix);
      if (previous?.segmentId === sample.segmentId) lines.push(...previous.position.toArray(), ...position.toArray());
      if (sample.kind === 'keyframe') points.push(...position.toArray());
      if (sample.kind === 'keyframe' && sample.surfacePoint) {
        const target = sample.surfacePoint;
        targets.push(...new THREE.Vector3(target.x, target.y, target.z).applyMatrix4(matrix).toArray());
      }
      previous = { position, segmentId: sample.segmentId };
    }
    const geometry = (values) => new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(values, 3));
    group.add(new THREE.LineSegments(geometry(lines), new THREE.LineBasicMaterial({ color: '#59dbe8', depthTest: false, transparent: true, opacity: 0.8 })));
    group.add(new THREE.Points(geometry(points), new THREE.PointsMaterial({ color: '#f4c95d', size: 8, sizeAttenuation: false, depthTest: false })));
    group.add(new THREE.Points(geometry(targets), new THREE.PointsMaterial({ color: '#5ee59a', size: 6, sizeAttenuation: false, depthTest: false })));
  }
  group.traverse((child) => { child.renderOrder = 30; });
  return group;
}

export function disposeIPadCaptureLayer(group) {
  group.removeFromParent(); group.traverse((child) => { child.geometry?.dispose(); child.material?.dispose(); });
}
