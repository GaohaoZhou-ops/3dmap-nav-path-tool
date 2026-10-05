import Foundation
import simd

@main struct PoseProximityTests {
    static func main() throws {
        func sample(_ position: SIMD3<Float>, segment: String = "segment") -> TeachingSample {
            TeachingSample(segmentId: segment, kind: "keyframe",
                cameraPose: CameraPose(position: Point3(position), quaternion: Rotation4(simd_quatf())))
        }
        let previous = sample(.zero)
        precondition(NearbyPoseConfirmation(sample: previous, previousSample: nil) == nil, "first Pose records directly")
        precondition(NearbyPoseConfirmation(sample: sample(.zero), previousSample: previous)?.distanceMeters == 0,
            "an identical position still needs explicit confirmation")
        for axis in [SIMD3<Float>(1, 0, 0), SIMD3(0, 1, 0), SIMD3(0, 0, 1)] {
            precondition(NearbyPoseConfirmation(sample: sample(axis * 0.099), previousSample: previous) != nil)
            precondition(NearbyPoseConfirmation(sample: sample(axis * 0.100), previousSample: previous) == nil,
                "exactly 10 cm records directly")
            precondition(NearbyPoseConfirmation(sample: sample(axis * 0.101), previousSample: previous) == nil)
        }
        precondition(NearbyPoseConfirmation(sample: sample(SIMD3(0.06, 0.06, 0.06)), previousSample: previous) == nil,
            "compare the full 3D distance, not each component or the ground plane")
        let diagonal = NearbyPoseConfirmation(sample: sample(SIMD3(0.03, -0.04, 0)), previousSample: previous)!
        precondition(abs(diagonal.distanceMeters - 0.05) < 0.000001)
        precondition(diagonal.message.contains("5.0 cm") && diagonal.message.contains("10 cm"), "convert meters to cm for the alert")

        var captured = sample(SIMD3(0.01, 0, 0), segment: "recalibrated-segment")
        captured.cameraPose.quaternion = Rotation4(simd_quatf(angle: .pi, axis: SIMD3(0, 0, 1)))
        captured.surfacePoint = Point3(SIMD3(1, 2, 3))
        captured.previewCameraTransform = matrix_identity_float4x4.elements
        captured.previewProjection = matrix_identity_float4x4.elements
        captured.previewAspect = 4.0 / 3.0
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let original = try encoder.encode(captured)
        let confirmation = NearbyPoseConfirmation(sample: captured, previousSample: previous)!
        precondition(confirmation.previousSampleID == previous.id && confirmation.id == captured.id,
            "a changed orientation or calibration does not bypass the distance reminder")
        captured.cameraPose.position = Point3(SIMD3(2, 3, 4))
        captured.capturedAt = "later"; captured.surfacePoint = nil
        let frozen = try encoder.encode(confirmation.sample)
        precondition(frozen == original, "confirmation preserves the capture time, transform, depth and preview together")

        var samples = [previous, sample(SIMD3(1, 0, 0))]
        let next = sample(SIMD3(0.02, 0, 0))
        precondition(NearbyPoseConfirmation(sample: next, previousSample: samples.last) == nil,
            "only compare the most recent Pose, not every historical Pose")
        samples.removeLast()
        precondition(NearbyPoseConfirmation(sample: next, previousSample: samples.last) != nil,
            "deleting the last Pose changes the next comparison")
        let restored = try JSONDecoder().decode([TeachingSample].self, from: encoder.encode(samples))
        precondition(NearbyPoseConfirmation(sample: next, previousSample: restored.last) != nil,
            "reopened drafts use their persisted last Pose")
        for value: Float in [.nan, .infinity, -.infinity] {
            precondition(NearbyPoseConfirmation(sample: sample(SIMD3(value, 0, 0)), previousSample: previous) == nil)
        }
        print("Pose proximity: first/identical/near/far, 10 cm boundary, XYZ distance, rotation, recalibration, frozen capture, deletion and reopened drafts passed.")
    }
}
