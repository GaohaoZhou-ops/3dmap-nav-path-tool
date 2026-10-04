import Foundation
import simd

// An observed floor footprint, projected onto a gravity-horizontal plane.
// Only ARKit anchors classified as a horizontal floor may enter this geometry.
struct GroundPlane {
    let boundary: [SIMD2<Float>]
    let height: Float
    let area: Float
    var vertices: [SIMD3<Float>] { boundary.map { SIMD3($0.x, height, $0.y) } }

    init?(worldFromPlane: simd_float4x4, boundary localBoundary: [SIMD3<Float>]) {
        guard localBoundary.count >= 3, worldFromPlane.elements.allSatisfy(\.isFinite) else { return nil }
        let axis = worldFromPlane.columns.1
        let normal = SIMD3(axis.x, axis.y, axis.z), length = simd_length(normal)
        // Horizontal anchors may contain small fitting errors. Reject slopes;
        // the displayed surface and placement ray both use the same level height.
        guard length > 0.0001, abs(normal.y / length) >= cos(5 * Float.pi / 180) else { return nil }
        let world = localBoundary.map { worldFromPlane * SIMD4($0, 1) }
        guard world.allSatisfy({ $0.x.isFinite && $0.y.isFinite && $0.z.isFinite }) else { return nil }
        let polygon = world.map { SIMD2($0.x, $0.z) }
        let signedArea = polygon.indices.reduce(Float.zero) { sum, index in
            let a = polygon[index], b = polygon[(index + 1) % polygon.count]
            return sum + a.x * b.y - b.x * a.y
        } / 2
        guard signedArea.isFinite, abs(signedArea) >= 0.04 else { return nil }
        boundary = signedArea > 0 ? polygon : Array(polygon.reversed())
        height = world.reduce(Float.zero) { $0 + $1.y } / Float(world.count)
        area = abs(signedArea)
    }

    func contains(_ point: SIMD2<Float>) -> Bool {
        guard point.x.isFinite, point.y.isFinite else { return false }
        // ARPlaneGeometry supplies a convex boundary, not a rectangular extent.
        return boundary.indices.allSatisfy { index in
            let a = boundary[index], edge = boundary[(index + 1) % boundary.count] - a, delta = point - a
            return edge.x * delta.y - edge.y * delta.x >= -0.0001
        }
    }

    func intersection(origin: SIMD3<Float>, direction: SIMD3<Float>) -> SIMD3<Float>? {
        guard [origin.x, origin.y, origin.z, direction.x, direction.y, direction.z].allSatisfy(\.isFinite),
              simd_length(direction) > 0.0001 else { return nil }
        let ray = simd_normalize(direction)
        guard ray.y < -0.0001 else { return nil }
        let distance = (height - origin.y) / ray.y
        guard distance >= 0.15, distance <= 6 else { return nil }
        let point = origin + ray * distance
        guard contains(SIMD2(point.x, point.z)) else { return nil }
        return SIMD3(point.x, height, point.z)
    }

    // A 25 cm grid clipped to the observed polygon. Bound the line count for
    // large floors instead of extending a grid across unobserved space.
    func gridLines() -> [SIMD3<Float>] {
        let minX = boundary.map(\.x).min()!, maxX = boundary.map(\.x).max()!
        let minZ = boundary.map(\.y).min()!, maxZ = boundary.map(\.y).max()!
        let step = max(0.25, ceil(max(maxX - minX, maxZ - minZ) / 32 / 0.25) * 0.25)
        var result: [SIMD3<Float>] = []
        for axis in 0...1 {
            let lower = axis == 0 ? minX : minZ, upper = axis == 0 ? maxX : maxZ
            let count = min(33, max(0, Int(floor(upper / step) - ceil(lower / step)) + 1))
            for index in 0..<count {
                let coordinate = (ceil(lower / step) + Float(index)) * step
                var crossings: [Float] = []
                for vertex in boundary.indices {
                    let a = boundary[vertex], b = boundary[(vertex + 1) % boundary.count]
                    let delta = b[axis] - a[axis]
                    guard abs(delta) > 0.00001 else { continue }
                    let fraction = (coordinate - a[axis]) / delta
                    if fraction >= 0, fraction <= 1 { crossings.append(a[1 - axis] + fraction * (b[1 - axis] - a[1 - axis])) }
                }
                if let start = crossings.min(), let end = crossings.max(), end - start > 0.0001 {
                    result += axis == 0 ? [SIMD3(coordinate, height, start), SIMD3(coordinate, height, end)]
                        : [SIMD3(start, height, coordinate), SIMD3(end, height, coordinate)]
                }
            }
        }
        return result
    }
}
