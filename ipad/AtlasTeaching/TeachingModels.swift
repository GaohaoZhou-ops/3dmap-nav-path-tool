import Foundation
import simd

let teachingProtocol = "atlas-ipad-teaching/1"
let maximumSamples = 50_000
let maximumModelBytes = 192 * 1024 * 1024
let maximumModelVertices = 5_000_000
let maximumModelIndices = 30_000_000

enum IPv4Input {
    static func acceptsOctet(_ text: String) -> Bool {
        text.isEmpty || (text.utf8.count <= 3 && text.utf8.allSatisfy { (48...57).contains($0) }
            && Int(text).map { (0...255).contains($0) } == true)
    }
    static func octets(_ host: String, allowingEmpty: Bool = false) -> [String]? {
        if host.isEmpty && allowingEmpty { return Array(repeating: "", count: 4) }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 4, parts.allSatisfy({ acceptsOctet($0) && (allowingEmpty || !$0.isEmpty) }) else { return nil }
        return parts
    }
}

enum PairingCode {
    static func normalize(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }
    static func isValid(_ value: String) -> Bool {
        let code = normalize(value)
        return code.utf8.count == 4 && code.utf8.allSatisfy { (65...90).contains($0) || (48...57).contains($0) }
    }
}

enum ModelDisplayMode: String, Codable, CaseIterable, Identifiable {
    case mesh, points
    var id: String { rawValue }
    var label: String { self == .mesh ? "Mesh" : "点云" }
}
enum PointDensity: String, Codable, CaseIterable, Identifiable {
    case automatic, five, ten, quarter, half, full
    var id: String { rawValue }
    var label: String {
        switch self {
        case .automatic: return "自动"
        case .five: return "5%"
        case .ten: return "10%"
        case .quarter: return "25%"
        case .half: return "50%"
        case .full: return "100%"
        }
    }
    func count(for vertices: Int) -> Int {
        let ratio: Double
        switch self {
        case .automatic: return min(vertices, 250_000)
        case .five: ratio = 0.05
        case .ten: ratio = 0.1
        case .quarter: ratio = 0.25
        case .half: ratio = 0.5
        case .full: ratio = 1
        }
        return min(vertices, max(1, Int(ceil(Double(vertices) * ratio))))
    }
}
enum MeshQuality: String, Codable, CaseIterable, Identifiable {
    case automatic, performance, balanced, detail, full
    var id: String { rawValue }
    var label: String {
        switch self {
        case .automatic: return "自动"
        case .performance: return "流畅"
        case .balanced: return "均衡"
        case .detail: return "精细"
        case .full: return "全量"
        }
    }
    func count(for faces: Int) -> Int {
        switch self {
        case .automatic: return faces <= 1_500_000 ? faces : min(faces, 650_000)
        case .performance: return min(faces, 180_000)
        case .balanced: return min(faces, 650_000)
        case .detail: return min(faces, 2_000_000)
        case .full: return faces
        }
    }
}
struct ModelDisplaySettings: Codable, Equatable {
    var mode = ModelDisplayMode.mesh
    var pointDensity = PointDensity.automatic
    var meshQuality = MeshQuality.automatic
}

struct Point3: Codable {
    var x: Float; var y: Float; var z: Float
    init(_ p: SIMD3<Float>) { x = p.x; y = p.y; z = p.z }
    var simd: SIMD3<Float> { SIMD3(x, y, z) }
}
struct Rotation4: Codable {
    var x: Float; var y: Float; var z: Float; var w: Float
    init(_ q: simd_quatf) { let v = q.normalized.vector; x = v.x; y = v.y; z = v.z; w = v.w }
}
struct CameraPose: Codable {
    var frameName = "ipad_camera_optical_frame"
    var position: Point3
    var quaternion: Rotation4
}
struct Calibration: Codable, Identifiable {
    var id = UUID().uuidString
    var capturedAt = timestamp()
    var worldFromModel: [Float]
    var referencePoint: Point3
    var yawDegrees: Float
    var rollDegrees: Float? = nil
    var pitchDegrees: Float? = nil
}
struct TeachingSample: Codable, Identifiable {
    var id = UUID().uuidString
    var name = ""
    var segmentId: String
    var capturedAt = timestamp()
    var kind: String
    var tracking = "normal"
    var cameraPose: CameraPose
    var surfacePoint: Point3?
    var previewCameraTransform: [Float]?
    var previewProjection: [Float]?
    var previewAspect: Float?
}
struct TeachingDevice: Codable {
    var model = "iPad Pro"
    var lidar = true
}
struct TeachingResult: Codable, Identifiable {
    var `protocol` = teachingProtocol
    var id = UUID().uuidString
    var sessionId: String
    var modelHash: String
    var coordinateFrame = "virtual_origin"
    var createdAt = timestamp()
    var completedAt: String?
    var device = TeachingDevice()
    var calibrations: [Calibration] = []
    var samples: [TeachingSample] = []
}
struct ModelBounds: Codable { var min: Point3; var max: Point3 }
struct ModelManifest: Codable {
    var `protocol`: String
    var modelHash: String
    var name: String
    var sourceHash: String
    var sourceMapId: String
    var coordinateFrame: String
    var distanceUnit: String
    var verticalAxis: String
    var vertices: Int
    var indices: Int
    var sampled: Bool
    var originalVertices: Int
    var byteLength: Int
    var bounds: ModelBounds?
}
struct PairedSession: Codable { var id: String; var deviceToken: String; var manifest: ModelManifest }
struct LocalProject: Codable, Identifiable {
    var id: String { session.id }
    var serverURL: String
    var session: PairedSession
    var result: TeachingResult
    var syncedAt: String?
    var displaySettings: ModelDisplaySettings?
}
struct TeachingError: LocalizedError {
    var message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
func timestamp() -> String { ISO8601DateFormatter().string(from: Date()) }

extension simd_float4x4 {
    init(elements: [Float]) {
        self.init(columns: (SIMD4(elements[0], elements[1], elements[2], elements[3]),
            SIMD4(elements[4], elements[5], elements[6], elements[7]), SIMD4(elements[8], elements[9], elements[10], elements[11]),
            SIMD4(elements[12], elements[13], elements[14], elements[15])))
    }
    var elements: [Float] { (0..<4).flatMap { column in (0..<4).map { self[column][$0] } } }
    var translation: SIMD3<Float> { SIMD3(columns.3.x, columns.3.y, columns.3.z) }
}

// A read-only comparison of the model's XY reference plane and the iPad screen.
// It uses the displayed camera basis, never gravity or a required target angle.
struct SpatialLevelReading: Equatable {
    let normalInScreen: SIMD3<Float>
    var planeDegrees: Float { atan2(simd_length(SIMD2(normalInScreen.x, normalInScreen.y)), abs(normalInScreen.z)) * 180 / .pi }
    var horizontalDegrees: Float { atan2(normalInScreen.x, simd_length(SIMD2(normalInScreen.y, normalInScreen.z))) * 180 / .pi }
    var verticalDegrees: Float { atan2(normalInScreen.y, simd_length(SIMD2(normalInScreen.x, normalInScreen.z))) * 180 / .pi }

    static func measure(worldFromModel: simd_float4x4, screenFromWorld: simd_float4x4) -> SpatialLevelReading? {
        let modelZ = worldFromModel.columns.2
        let vector = screenFromWorld * SIMD4(modelZ.x, modelZ.y, modelZ.z, 0)
        let normal = SIMD3(vector.x, vector.y, vector.z), length = simd_length(normal)
        guard normal.x.isFinite, normal.y.isFinite, normal.z.isFinite, length.isFinite, length > 0.000001 else { return nil }
        return SpatialLevelReading(normalInScreen: normal / length)
    }
}

enum TeachingCoordinates {
    // Model: right-handed Z up. ARKit world: right-handed Y up.
    static let zUpToAR = simd_float4x4(columns: (
        SIMD4(1, 0, 0, 0), SIMD4(0, 0, -1, 0), SIMD4(0, 1, 0, 0), SIMD4(0, 0, 0, 1)))
    // AR camera looks along -Z with +Y up. Optical camera looks along +Z with +Y down.
    static let opticalToARCamera = simd_float4x4(diagonal: SIMD4(1, -1, -1, 1))
    static func placement(hit: SIMD3<Float>, reference: SIMD3<Float>, yaw: Float, roll: Float = 0, pitch: Float = 0) -> simd_float4x4 {
        let rotation = simd_quatf(angle: yaw * .pi / 180, axis: SIMD3<Float>(0, 0, 1))
            * simd_quatf(angle: pitch * .pi / 180, axis: SIMD3<Float>(0, 1, 0))
            * simd_quatf(angle: roll * .pi / 180, axis: SIMD3<Float>(1, 0, 0))
        var worldFromModel = zUpToAR * simd_float4x4(rotation)
        let offset = worldFromModel * SIMD4(reference, 0)
        worldFromModel.columns.3 = SIMD4(hit, 1) - offset
        return worldFromModel
    }
    static func opticalPose(camera: simd_float4x4, worldFromModel: simd_float4x4) -> CameraPose {
        let modelFromOptical = worldFromModel.inverse * camera * opticalToARCamera
        return CameraPose(position: Point3(modelFromOptical.translation), quaternion: Rotation4(simd_quatf(modelFromOptical)))
    }
    static func modelPoint(_ world: SIMD3<Float>, worldFromModel: simd_float4x4) -> Point3 {
        let p = worldFromModel.inverse * SIMD4(world, 1)
        return Point3(SIMD3(p.x, p.y, p.z))
    }
}
