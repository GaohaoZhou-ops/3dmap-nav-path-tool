import Foundation
import CoreGraphics
import simd

/// A nominal, co-located M70 optical frustum; this is a viewing aid, not calibration.
/// Matches ZIVID_M70_PROFILE in the desktop app. Zivid's 700 mm working-distance
/// footprint is 754 × 449 mm. The camera/projector overlap varies between units.
struct ZividFieldOfView: Equatable {
    static let horizontalDegrees: CGFloat = 56.6
    static let verticalDegrees: CGFloat = 35.6
    static let previewVerticalDegrees: CGFloat = 60

    let imageAspect: CGFloat
    /// Normalized display coordinates, before clipping. Never shrink a frustum
    /// to hide an insufficient iPad camera FOV.
    let aperture: CGRect

    var fullyVisible: Bool {
        let tolerance: CGFloat = 0.0001
        return aperture.minX >= -tolerance && aperture.minY >= -tolerance
            && aperture.maxX <= 1 + tolerance && aperture.maxY <= 1 + tolerance
    }

    static func project(intrinsics: simd_float3x3, resolution: CGSize,
                        displayTransform: CGAffineTransform, displaySize: CGSize) -> Self? {
        guard resolution.width.isFinite, resolution.height.isFinite,
              resolution.width > 0, resolution.height > 0,
              displaySize.width.isFinite, displaySize.height.isFinite,
              displaySize.width > 0, displaySize.height > 0,
              intrinsics[0].x > 0, intrinsics[1].y > 0 else { return nil }
        let halfWidth = Float(tan(horizontalDegrees * .pi / 360))
        let halfHeight = Float(tan(verticalDegrees * .pi / 360))
        var points: [CGPoint] = []
        // M70 +X right / +Y down shares the iPad optical frame used by saved Poses.
        // ARKit's display transform handles screen rotation and the principal point.
        for x in [-halfWidth, halfWidth] {
            for y in [-halfHeight, halfHeight] {
                let pixel = intrinsics * SIMD3(x, y, 1)
                guard pixel.x.isFinite, pixel.y.isFinite, pixel.z.isFinite, pixel.z > 0 else { return nil }
                let point = CGPoint(x: CGFloat(pixel.x / pixel.z) / resolution.width,
                                    y: CGFloat(pixel.y / pixel.z) / resolution.height).applying(displayTransform)
                guard point.x.isFinite, point.y.isFinite else { return nil }
                points.append(point)
            }
        }
        let x = points.map(\.x), y = points.map(\.y)
        let aperture = CGRect(x: x.min()!, y: y.min()!, width: x.max()! - x.min()!, height: y.max()! - y.min()!)
        guard aperture.width > 0, aperture.height > 0 else { return nil }
        return Self(imageAspect: displaySize.width / displaySize.height, aperture: aperture)
    }

    func fittedSize(in available: CGSize) -> CGSize {
        guard available.width > 0, available.height > 0 else { return .zero }
        let width = min(available.width, available.height * imageAspect)
        return CGSize(width: width, height: width / imageAspect)
    }

    func aperture(in size: CGSize) -> CGRect {
        CGRect(x: aperture.minX * size.width, y: aperture.minY * size.height,
               width: aperture.width * size.width, height: aperture.height * size.height)
    }

    /// The orbitable model preview uses an explicit 60° vertical perspective.
    static let modelPreview: Self = {
        let focal = Float(3 / (2 * tan(previewVerticalDegrees * .pi / 360)))
        return project(intrinsics: simd_float3x3(columns: (SIMD3(focal, 0, 0), SIMD3(0, focal, 0), SIMD3(2, 1.5, 1))),
                       resolution: CGSize(width: 4, height: 3), displayTransform: .identity,
                       displaySize: CGSize(width: 4, height: 3))!
    }()
}
