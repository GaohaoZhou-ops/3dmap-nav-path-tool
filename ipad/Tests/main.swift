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
let upright = SpatialLevelReading.measure(screenFromWorld: identity)!
angleNear(upright.zDeviationDegrees, 0, "upright iPad Z points opposite gravity")
precondition(upright.isAligned)
near(upright.deviceAxesInReference.columns.0, SIMD3(0, 1, 0), "body X points through the rear camera")
near(upright.deviceAxesInReference.columns.1, SIMD3(-1, 0, 0), "body Y points toward screen-left")
near(upright.deviceAxesInReference.columns.2, SIMD3(0, 0, 1), "body Z points toward screen-top")
for angle: Float in [0, 1.49, 1.5, 1.51, 1.54, 10, 30, 89, 90, 120, 180] {
    for axis in [SIMD3<Float>(1, 0, 0), SIMD3(0, 0, 1)] {
        for sign: Float in [-1, 1] {
            let worldFromScreen = rotation(sign * angle, axis)
            let reading = SpatialLevelReading.measure(screenFromWorld: worldFromScreen.inverse)!
            angleNear(reading.zDeviationDegrees, angle, "pitch and roll use the directed gravity-up angle")
            precondition(reading.isAligned == (angle <= 1.5), "1.5 degrees is inclusive; display rounding never controls the green state")
            let axes = reading.deviceAxesInReference
            near(simd_cross(axes.columns.0, axes.columns.1), axes.columns.2, "live axes remain right handed")
        }
    }
}
for yaw: Float in [-180, -120, 0, 90, 180] {
    let worldFromScreen = rotation(yaw, SIMD3(0, 1, 0))
    let reading = SpatialLevelReading.measure(screenFromWorld: worldFromScreen.inverse)!
    angleNear(reading.zDeviationDegrees, 0, "heading changes leave the upright Z axis aligned")
    precondition(reading.isAligned)
}
let tiltedDevice = rotation(25, SIMD3(1, 0, 0)) * rotation(-40, SIMD3(0, 0, 1))
let level = SpatialLevelReading.measure(screenFromWorld: tiltedDevice.inverse)!
angleNear(level.zDeviationDegrees, acos(cos(Float(25) * .pi / 180) * cos(Float(40) * .pi / 180)) * 180 / .pi, "combined tilt")
let slightCombinedTilt = rotation(1.1, SIMD3(1, 0, 0)) * rotation(1.1, SIMD3(0, 0, 1))
precondition(!SpatialLevelReading.measure(screenFromWorld: slightCombinedTilt.inverse)!.isAligned,
    "individually small pitch and roll can exceed the 1.5 degree 3D tolerance")
var translatedDevice = tiltedDevice; translatedDevice.columns.3 = SIMD4(30, -10, 200, 1)
let translatedReading = SpatialLevelReading.measure(screenFromWorld: translatedDevice.inverse)!
angleNear(translatedReading.zDeviationDegrees, level.zDeviationDegrees, "distance never changes device tilt")
for column in 0..<3 { near(translatedReading.deviceAxesInReference[column], level.deviceAxesInReference[column], "translation never changes displayed axes") }
let sensorFromPortraitScreen = rotation(90, SIMD3(0, 0, 1))
let worldFromRotatedSensor = tiltedDevice * sensorFromPortraitScreen.inverse
let portraitReading = SpatialLevelReading.measure(screenFromWorld: (worldFromRotatedSensor * sensorFromPortraitScreen).inverse)!
angleNear(portraitReading.zDeviationDegrees, level.zDeviationDegrees, "display-orientation correction preserves the visible screen's body frame")
precondition(SpatialLevelReading.measure(screenFromWorld: simd_float4x4()) == nil, "invalid transforms never turn green")
var invalid = identity; invalid.columns.2.x = .nan
precondition(SpatialLevelReading.measure(screenFromWorld: invalid) == nil)
invalid = identity; invalid.columns.0.x = -1
precondition(SpatialLevelReading.measure(screenFromWorld: invalid) == nil, "reject reflected left-handed transforms")
invalid = identity; invalid.columns.1 = invalid.columns.0
precondition(SpatialLevelReading.measure(screenFromWorld: invalid) == nil, "reject degenerate axes")
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
print("Swift coordinates, free model tilt, gravity-relative device axes, 1.5-degree alignment, orientation changes, invalid readings and backward-compatible Pose serialization passed.")
