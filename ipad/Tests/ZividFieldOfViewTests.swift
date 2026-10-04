import Foundation
import simd

@main
enum ZividFieldOfViewTests {
    static func main() {
        func near(_ value: CGFloat, _ expected: CGFloat, _ message: String, tolerance: CGFloat = 0.0001) {
            precondition(abs(value - expected) < tolerance, "\(message): \(value) != \(expected)")
        }
        // An off-centre principal point catches a superficially plausible but
        // incorrect screen-centred / fixed-aspect-ratio overlay.
        let intrinsics = simd_float3x3(columns: (SIMD3(1250, 0, 0), SIMD3(0, 1230, 0), SIMD3(975, 701, 1)))
        let resolution = CGSize(width: 1920, height: 1440)
        let rotations: [(CGAffineTransform, CGSize)] = [
            (.identity, resolution),
            (CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: 1, ty: 1), resolution),
            (CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 1, ty: 0), CGSize(width: 1440, height: 1920)),
            (CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: 0, ty: 1), CGSize(width: 1440, height: 1920)),
        ]
        for (transform, displaySize) in rotations {
            let reference = ZividFieldOfView.project(intrinsics: intrinsics, resolution: resolution,
                displayTransform: transform, displaySize: displaySize)!
            precondition(reference.fullyVisible)
            let center = CGPoint(x: 975.0 / 1920, y: 701.0 / 1440).applying(transform)
            near(reference.aperture.midX, center.x, "retain optical principal point X")
            near(reference.aperture.midY, center.y, "retain optical principal point Y")
            for available in [CGSize(width: 854, height: 812), CGSize(width: 494, height: 1174), CGSize(width: 500, height: 300)] {
                let fitted = reference.fittedSize(in: available)
                precondition(fitted.width <= available.width && fitted.height <= available.height + 0.0001)
                near(fitted.width / fitted.height, displaySize.width / displaySize.height, "fitting preserves camera aspect")
                precondition(abs(fitted.width - available.width) < 0.0001 || abs(fitted.height - available.height) < 0.0001)
                let aperture = reference.aperture(in: fitted)
                var horizontal: [CGFloat] = [], vertical: [CGFloat] = []
                for x in [aperture.minX, aperture.maxX] {
                    for y in [aperture.minY, aperture.maxY] {
                        let sensor = CGPoint(x: x / fitted.width, y: y / fitted.height).applying(transform.inverted())
                        let ray = intrinsics.inverse * SIMD3(Float(sensor.x * resolution.width), Float(sensor.y * resolution.height), 1)
                        horizontal.append(CGFloat(atan2(ray.x, ray.z)) * 180 / .pi)
                        vertical.append(CGFloat(atan2(ray.y, ray.z)) * 180 / .pi)
                    }
                }
                near(horizontal.max()! - horizontal.min()!, 56.6, "back-projected horizontal rays span M70's angle in all orientations")
                near(vertical.max()! - vertical.min()!, 35.6, "back-projected vertical rays span M70's angle in all orientations")
            }
        }
        // Vendor footprint at focus, allowing for rounded nominal angles.
        near(1400 * tan(ZividFieldOfView.horizontalDegrees * .pi / 360), 754, "vendor focus width", tolerance: 1)
        near(1400 * tan(ZividFieldOfView.verticalDegrees * .pi / 360), 449, "vendor focus height", tolerance: 1)
        let narrow = simd_float3x3(columns: (SIMD3(2500, 0, 0), SIMD3(0, 2500, 0), SIMD3(960, 720, 1)))
        let clipped = ZividFieldOfView.project(intrinsics: narrow, resolution: resolution,
            displayTransform: .identity, displaySize: resolution)!
        precondition(!clipped.fullyVisible && clipped.aperture.minX < 0 && clipped.aperture.maxX > 1,
                     "insufficient camera FOV is reported, never silently fitted into a false smaller opening")
        for invalid in [CGSize.zero, CGSize(width: CGFloat.infinity, height: 100), CGSize(width: -1, height: 100)] {
            precondition(ZividFieldOfView.project(intrinsics: intrinsics, resolution: invalid,
                displayTransform: .identity, displaySize: resolution) == nil)
            precondition(ZividFieldOfView.project(intrinsics: intrinsics, resolution: resolution,
                displayTransform: .identity, displaySize: invalid) == nil)
        }
        var badIntrinsics = intrinsics; badIntrinsics[0].x = .nan
        precondition(ZividFieldOfView.project(intrinsics: badIntrinsics, resolution: resolution,
            displayTransform: .identity, displaySize: resolution) == nil)
        precondition(ZividFieldOfView.project(intrinsics: intrinsics, resolution: resolution,
            displayTransform: CGAffineTransform(scaleX: 0, y: 0), displaySize: resolution) == nil)
        let preview = ZividFieldOfView.modelPreview
        precondition(preview.fullyVisible)
        near(preview.imageAspect, 4 / 3, "orbit preview retains its known perspective aspect")
        near(2 * atan(preview.aperture.height * tan(.pi / 6)) * 180 / .pi, 35.6, "preview uses SceneKit's explicit 60° perspective")
        print("M70 optical rays, principal point, all screen rotations, viewport fitting, vendor footprint and insufficient-FOV handling passed.")
    }
}
