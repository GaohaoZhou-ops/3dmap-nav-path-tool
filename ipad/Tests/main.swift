import Foundation
import simd

func near(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ label: String) {
    precondition(simd_distance(a, b) < 0.0001, "\(label): \(a) != \(b)")
}
let reference = SIMD3<Float>(10, 20, 1)
let hit = SIMD3<Float>(1.2, 0.4, -2)
for yaw: Float in [0, 45, 90, -130, 180] {
    let worldFromModel = TeachingCoordinates.placement(hit: hit, reference: reference, yaw: yaw)
    let position = worldFromModel * SIMD4(reference, 1)
    near(SIMD3(position.x, position.y, position.z), hit, "reference placement")
    near(TeachingCoordinates.modelPoint(hit, worldFromModel: worldFromModel).simd, reference, "inverse placement")
    precondition(abs(simd_determinant(worldFromModel) - 1) < 0.0001, "right handed rigid transform")
    var camera = simd_float4x4(simd_quatf(angle: 0.3, axis: SIMD3(0, 1, 0)))
    camera.columns.3 = SIMD4(2, 1, -1, 1)
    let pose = TeachingCoordinates.opticalPose(camera: camera, worldFromModel: worldFromModel)
    near(pose.position.simd, TeachingCoordinates.modelPoint(camera.translation, worldFromModel: worldFromModel).simd, "camera translation")
    let q = pose.quaternion
    var reconstructed = simd_float4x4(simd_quatf(ix: q.x, iy: q.y, iz: q.z, r: q.w))
    reconstructed.columns.3 = SIMD4(pose.position.simd, 1)
    let recoveredCamera = worldFromModel * reconstructed * TeachingCoordinates.opticalToARCamera
    for column in 0..<4 { precondition(simd_length(recoveredCamera[column] - camera[column]) < 0.0001, "optical orientation round trip") }
}
let sessionID = UUID().uuidString
var result = TeachingResult(sessionId: sessionID, modelHash: String(repeating: "a", count: 64))
let calibration = Calibration(worldFromModel: TeachingCoordinates.zUpToAR.elements, referencePoint: Point3(SIMD3.zero), yawDegrees: 0)
result.calibrations = [calibration]
result.samples = [TeachingSample(name: "Pose 001", segmentId: calibration.id, kind: "keyframe",
    cameraPose: TeachingCoordinates.opticalPose(camera: matrix_identity_float4x4, worldFromModel: TeachingCoordinates.zUpToAR))]
result.completedAt = timestamp()
let data = try JSONEncoder().encode(result)
let decoded = try JSONDecoder().decode(TeachingResult.self, from: data)
precondition(decoded.samples.count == 1 && decoded.samples[0].name == "Pose 001")
if let output = CommandLine.arguments.dropFirst().first { try data.write(to: URL(fileURLWithPath: output)) }
print("Swift coordinates, handedness, camera optical basis and Pose serialization passed.")
