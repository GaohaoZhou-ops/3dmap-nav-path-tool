import Foundation
import simd

/// A virtual optical frame at ARKit's device anchor: +X right, +Y down, +Z forward.
/// It is neither an eye-gaze ray nor a calibrated physical camera extrinsic.
enum VisionPoseMath {
    static let frameName = "visionpro_head_optical_frame"

    static func isRigid(_ matrix: simd_float4x4) -> Bool {
        guard matrix.elements.allSatisfy(\.isFinite),
              abs(matrix[0].w) + abs(matrix[1].w) + abs(matrix[2].w) < 0.0001,
              abs(matrix[3].w - 1) < 0.0001 else { return false }
        let axes = (0..<3).map { SIMD3(matrix[$0].x, matrix[$0].y, matrix[$0].z) }
        let rotation = simd_float3x3(columns: (axes[0], axes[1], axes[2]))
        return (0..<3).allSatisfy { a in (0..<3).allSatisfy { b in
            abs(simd_dot(axes[a], axes[b]) - (a == b ? 1 : 0)) < 0.001
        }} && abs(simd_determinant(rotation) - 1) < 0.001
    }

    static func sample(device: simd_float4x4, worldFromModel: simd_float4x4,
                       segmentID: String) throws -> TeachingSample {
        guard isRigid(device), isRigid(worldFromModel), !segmentID.isEmpty else {
            throw TeachingError("空间变换无效，请重新放置并校准模型")
        }
        var pose = TeachingCoordinates.opticalPose(camera: device, worldFromModel: worldFromModel)
        pose.frameName = frameName
        return TeachingSample(segmentId: segmentID, kind: "keyframe", cameraPose: pose,
            previewCameraTransform: (worldFromModel.inverse * device).elements)
    }

    /// Triangle intersection, bounded to the observed mesh (never a plane's bounding rectangle).
    static func intersection(origin: SIMD3<Float>, direction: SIMD3<Float>,
                             vertices: [SIMD3<Float>], indices: [UInt32]) -> SIMD3<Float>? {
        guard (0..<3).allSatisfy({ origin[$0].isFinite && direction[$0].isFinite }),
              simd_length(direction) > 0.0001, indices.count % 3 == 0 else { return nil }
        let ray = simd_normalize(direction)
        var closest: Float = 6.001
        for index in stride(from: 0, to: indices.count, by: 3) {
            let ids = [indices[index], indices[index + 1], indices[index + 2]].map(Int.init)
            guard ids.allSatisfy({ $0 < vertices.count }) else { continue }
            let a = vertices[ids[0]], ab = vertices[ids[1]] - a, ac = vertices[ids[2]] - a
            let p = simd_cross(ray, ac), determinant = simd_dot(ab, p)
            guard abs(determinant) > 0.000001 else { continue }
            let t = origin - a, u = simd_dot(t, p) / determinant
            guard u >= 0, u <= 1 else { continue }
            let q = simd_cross(t, ab), v = simd_dot(ray, q) / determinant
            guard v >= 0, u + v <= 1 else { continue }
            let distance = simd_dot(ac, q) / determinant
            if distance >= 0.15 && distance <= 6 && distance < closest { closest = distance }
        }
        return closest <= 6 ? origin + closest * ray : nil
    }
}

/// Placement edits are a draft until confirmed. Each confirmation starts a new segment.
struct VisionPlacement {
    var reference = SIMD3<Float>.zero
    var hit: SIMD3<Float>?
    var yaw: Float = 0
    var roll: Float = 0
    var pitch: Float = 0
    private(set) var calibration: Calibration?
    private(set) var lockedTransform: simd_float4x4?
    private var rotationCorrection = matrix_identity_float4x4
    init(reference: SIMD3<Float> = .zero) { self.reference = reference }
    var transform: simd_float4x4? {
        if let lockedTransform { return lockedTransform }
        guard let hit else { return nil }
        var matrix = rotationCorrection * TeachingCoordinates.placement(hit: .zero, reference: .zero, yaw: yaw, roll: roll, pitch: pitch)
        matrix.columns.3 = SIMD4(hit, 1) - matrix * SIMD4(reference, 0)
        return matrix
    }
    var isCalibrated: Bool { calibration != nil }
    mutating func unlock() {
        if let transform {
            hit = (transform * SIMD4(reference, 1)).xyz
            var rotation = transform; rotation.columns.3 = SIMD4(0, 0, 0, 1)
            let nominal = TeachingCoordinates.placement(hit: .zero, reference: .zero, yaw: yaw, roll: roll, pitch: pitch)
            rotationCorrection = rotation * nominal.inverse
        }
        calibration = nil; lockedTransform = nil
    }
    mutating func confirm() throws -> Calibration {
        guard let transform, VisionPoseMath.isRigid(transform) else { throw TeachingError("请先放置模型") }
        let value = Calibration(worldFromModel: transform.elements, referencePoint: Point3(reference),
            yawDegrees: yaw, rollDegrees: roll, pitchDegrees: pitch)
        calibration = value; lockedTransform = transform
        return value
    }
    mutating func refine(_ transform: simd_float4x4) {
        guard isCalibrated, VisionPoseMath.isRigid(transform) else { return }
        lockedTransform = transform
    }
}

extension SIMD4 where Scalar == Float {
    var xyz: SIMD3<Float> { SIMD3(x, y, z) }
}
