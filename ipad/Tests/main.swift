import Foundation
import simd

func near(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ label: String) {
    precondition(simd_distance(a, b) < 0.0001, "\(label): \(a) != \(b)")
}
let reference = SIMD3<Float>(10, 20, 1)
let hit = SIMD3<Float>(1.2, 0.4, -2)
for yaw: Float in [0, 45, 90, -130, 180] { for tilt: SIMD2<Float> in [SIMD2(0, 0), SIMD2(35, -20), SIMD2(-70, 80), SIMD2(180, 90)] {
    let worldFromModel = TeachingCoordinates.placement(hit: hit, reference: reference, yaw: yaw, roll: tilt.x, pitch: tilt.y)
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
} }
func angleNear(_ value: Float, _ expected: Float, _ label: String) {
    precondition(abs(value - expected) < 0.001, "\(label): \(value) != \(expected)")
}
func rotation(_ degrees: Float, _ axis: SIMD3<Float>) -> simd_float4x4 {
    simd_float4x4(simd_quatf(angle: degrees * .pi / 180, axis: axis))
}
let identity = matrix_identity_float4x4
for angle: Float in [0, 10, 30, 89, 90, 120, 180] {
    let model = rotation(angle, SIMD3(0, 1, 0))
    let level = SpatialLevelReading.measure(worldFromModel: model, screenFromWorld: identity)!
    angleNear(level.planeDegrees, min(angle, 180 - angle), "plane angle is independent of front/back normal")
    angleNear(level.horizontalDegrees, min(angle, 180 - angle), "screen-relative horizontal component")
    angleNear(level.verticalDegrees, 0, "pure horizontal tilt")
}
let tiltedModel = rotation(25, SIMD3(0, 1, 0)) * rotation(-40, SIMD3(1, 0, 0))
let level = SpatialLevelReading.measure(worldFromModel: tiltedModel, screenFromWorld: identity)!
angleNear(level.planeDegrees, acos(cos(Float(25) * .pi / 180) * cos(Float(40) * .pi / 180)) * 180 / .pi, "combined tilt")
let screenRotation = rotation(90, SIMD3(0, 0, 1))
let rotatedScreen = SpatialLevelReading.measure(worldFromModel: tiltedModel, screenFromWorld: screenRotation)!
angleNear(rotatedScreen.planeDegrees, level.planeDegrees, "portrait/landscape keep the plane angle")
angleNear(rotatedScreen.horizontalDegrees, -level.verticalDegrees, "portrait/landscape rotate the horizontal component")
angleNear(rotatedScreen.verticalDegrees, level.horizontalDegrees, "portrait/landscape rotate the vertical component")
var translatedModel = tiltedModel; translatedModel.columns.3 = SIMD4(30, -10, 200, 1)
var translatedView = identity; translatedView.columns.3 = SIMD4(-3, 18, 4, 1)
precondition(SpatialLevelReading.measure(worldFromModel: translatedModel, screenFromWorld: translatedView) == level, "distance never changes a tilt reading")
let globalRotation = rotation(70, simd_normalize(SIMD3(1, 2, 3)))
let rotatedWorld = SpatialLevelReading.measure(worldFromModel: globalRotation * tiltedModel, screenFromWorld: globalRotation.inverse)!
angleNear(rotatedWorld.planeDegrees, level.planeDegrees, "no gravity alignment is required")
near(rotatedWorld.normalInScreen, level.normalInScreen, "same relative pose in any world orientation")
precondition(SpatialLevelReading.measure(worldFromModel: simd_float4x4(), screenFromWorld: identity) == nil, "invalid transforms never display a zero angle")
var nonFinite = identity; nonFinite.columns.2.x = .nan
precondition(SpatialLevelReading.measure(worldFromModel: nonFinite, screenFromWorld: identity) == nil)
let sessionID = UUID().uuidString
var result = TeachingResult(sessionId: sessionID, modelHash: String(repeating: "a", count: 64))
let calibration = Calibration(worldFromModel: TeachingCoordinates.placement(hit: .zero, reference: .zero, yaw: 0, roll: 30, pitch: -25).elements,
    referencePoint: Point3(SIMD3.zero), yawDegrees: 0, rollDegrees: 30, pitchDegrees: -25)
result.calibrations = [calibration]
result.samples = [TeachingSample(name: "Pose 001", segmentId: calibration.id, kind: "keyframe",
    cameraPose: TeachingCoordinates.opticalPose(camera: matrix_identity_float4x4, worldFromModel: simd_float4x4(elements: calibration.worldFromModel)))]
result.completedAt = timestamp()
let data = try JSONEncoder().encode(result)
let decoded = try JSONDecoder().decode(TeachingResult.self, from: data)
precondition(decoded.samples.count == 1 && decoded.samples[0].name == "Pose 001")
precondition(decoded.calibrations[0].rollDegrees == 30 && decoded.calibrations[0].pitchDegrees == -25, "free model tilt survives offline serialization")
var legacy = try JSONSerialization.jsonObject(with: JSONEncoder().encode(calibration)) as! [String: Any]
legacy.removeValue(forKey: "rollDegrees"); legacy.removeValue(forKey: "pitchDegrees")
let oldCalibration = try JSONDecoder().decode(Calibration.self, from: JSONSerialization.data(withJSONObject: legacy))
precondition(oldCalibration.rollDegrees == nil && oldCalibration.pitchDegrees == nil, "older drafts remain readable")
if let output = CommandLine.arguments.dropFirst().first { try data.write(to: URL(fileURLWithPath: output)) }
print("Swift coordinates, free model tilt, screen-relative level angles, orientation changes, invalid readings and backward-compatible Pose serialization passed.")
