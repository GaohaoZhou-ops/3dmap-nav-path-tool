import Foundation
import simd

@main
enum GroundPlaneTests {
    static func main() {
        let square: [SIMD3<Float>] = [SIMD3(-1, 0, -1), SIMD3(1, 0, -1), SIMD3(1, 0, 1), SIMD3(-1, 0, 1)]
        func near(_ a: SIMD3<Float>?, _ b: SIMD3<Float>, _ message: String) {
            precondition(a != nil && simd_distance(a!, b) < 0.0001, message)
        }
        let identity = matrix_identity_float4x4
        let floor = GroundPlane(worldFromPlane: identity, boundary: square)!
        precondition(abs(floor.area - 4) < 0.0001)
        near(floor.intersection(origin: SIMD3(0, 1.6, 0), direction: SIMD3(0.2, -1.6, 0.4)), SIMD3(0.2, 0, 0.4), "screen ray intersects the measured floor height")
        near(floor.intersection(origin: SIMD3(1, 1, 1), direction: SIMD3(0, -1, 0)), SIMD3(1, 0, 1), "observed boundaries are usable")
        for (origin, direction) in [
            (SIMD3<Float>(1.01, 1, 0), SIMD3<Float>(0, -1, 0)),
            (SIMD3(0, 1, 0), SIMD3(1, 0, 0)),
            (SIMD3(0, 1, 0), SIMD3(0, 1, 0)),
            (SIMD3(0, -1, 0), SIMD3(0, -1, 0)),
            (SIMD3(0, 6.01, 0), SIMD3(0, -1, 0)),
            (SIMD3(0, 0.1, 0), SIMD3(0, -1, 0)),
            (SIMD3(0, 1, 0), SIMD3.zero),
            (SIMD3(0, 1, 0), SIMD3(.nan, -1, 0)),
        ] {
            precondition(floor.intersection(origin: origin, direction: direction) == nil, "never place outside observed geometry, behind the camera or beyond depth range")
        }
        let reversed = GroundPlane(worldFromPlane: identity, boundary: Array(square.reversed()))!
        near(reversed.intersection(origin: SIMD3(0, 1, 0), direction: SIMD3(0, -1, 0)), .zero, "boundary winding does not change placement")
        var transform = simd_float4x4(simd_quatf(angle: .pi / 3, axis: SIMD3(0, 1, 0)))
        transform.columns.3 = SIMD4(10, -0.7, -4, 1)
        let translated = GroundPlane(worldFromPlane: transform, boundary: square)!
        near(translated.intersection(origin: SIMD3(10, 1, -4), direction: SIMD3(0, -1, 0)), SIMD3(10, -0.7, -4), "anchor translation and yaw use AR world X/Z, with Y as gravity height")
        for tilt: Float in [30, 90] {
            let slope = simd_float4x4(simd_quatf(angle: tilt * .pi / 180, axis: SIMD3(1, 0, 0)))
            precondition(GroundPlane(worldFromPlane: slope, boundary: square) == nil, "slopes and walls are not ground references")
        }
        let slightTilt = simd_float4x4(simd_quatf(angle: .pi / 180, axis: SIMD3(1, 0, 0)))
        let leveled = GroundPlane(worldFromPlane: slightTilt, boundary: square)!
        precondition(leveled.vertices.allSatisfy { $0.y == leveled.height }, "small fitting noise is flattened consistently for drawing and placement")
        var invalid = identity; invalid.columns.3.y = .infinity
        precondition(GroundPlane(worldFromPlane: invalid, boundary: square) == nil)
        precondition(GroundPlane(worldFromPlane: identity, boundary: [SIMD3.zero, SIMD3(1, 0, 0), SIMD3(2, 0, 0)]) == nil)
        precondition(GroundPlane(worldFromPlane: identity, boundary: square.map { $0 * 0.01 }) == nil)

        let triangle = GroundPlane(worldFromPlane: identity, boundary: [SIMD3(-1, 0, -1), SIMD3(1, 0, -1), SIMD3(0, 0, 1)])!
        precondition(!triangle.contains(SIMD2(0.9, 0.9)), "do not extend the footprint to its rectangular extent")
        for plane in [floor, triangle, translated, GroundPlane(worldFromPlane: identity, boundary: square.map { $0 * 50 })!] {
            let grid = plane.gridLines()
            precondition(!grid.isEmpty && grid.count % 2 == 0 && grid.count <= 132, "grid work remains bounded")
            precondition(grid.allSatisfy { plane.contains(SIMD2($0.x, $0.z)) && $0.y == plane.height }, "all grid lines stay within the same floor used for placement")
        }
        let hit = translated.intersection(origin: SIMD3(10, 1, -4), direction: SIMD3(0, -1, 0))!
        let reference = SIMD3<Float>(2, 3, 0.5)
        let model = TeachingCoordinates.placement(hit: hit, reference: reference, yaw: 42, roll: 30, pitch: -25)
        let placedReference = model * SIMD4(reference, 1)
        near(SIMD3(placedReference.x, placedReference.y, placedReference.z), hit, "floor placement preserves the selected model reference")
        precondition(abs(model.columns.2.y) < 0.95, "ground assistance must not force the model upright")
        print("Ground boundary, gravity alignment, finite ray hits, range, grid clipping and freely tilted model placement passed.")
    }
}
