import Foundation
import SceneKit
import Metal
import CryptoKit
import AppKit

@main struct TeachingCoverageTests {
    static func model(_ points: [SIMD3<Float>], _ indices: [UInt32]) throws -> ModelGeometry {
        var data = Data(count: 32 + points.count * 16 + indices.count * 4)
        data.withUnsafeMutableBytes { raw in
            let words = raw.bindMemory(to: UInt32.self)
            words[0] = 0x534c5441; words[1] = 1; words[2] = UInt32(points.count); words[3] = UInt32(indices.count)
            for (index, point) in points.enumerated() {
                for axis in 0..<3 { words[8 + index * 3 + axis] = point[axis].bitPattern }
                words[8 + points.count * 3 + index] = 0xff808080
            }
            for (index, value) in indices.enumerated() { words[8 + points.count * 4 + index] = value }
        }
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return try ModelGeometry(data: data, manifest: ModelManifest(protocol: teachingProtocol, modelHash: hash,
            name: "coverage-test", sourceHash: hash, sourceMapId: "coverage-test", coordinateFrame: "virtual_origin",
            distanceUnit: "meter", verticalAxis: "Z", vertices: points.count, indices: indices.count,
            sampled: false, originalVertices: points.count, byteLength: data.count,
            bounds: ModelBounds(min: Point3(SIMD3(-3, -3, -3)), max: Point3(SIMD3(3, 3, 3)))))
    }
    static func plane(z: Float, radius: Float = 2) -> [SIMD3<Float>] {
        [SIMD3(-radius, -radius, z), SIMD3(radius, -radius, z), SIMD3(radius, radius, z), SIMD3(-radius, radius, z)]
    }
    static let quad: [UInt32] = [0, 1, 2, 0, 2, 3]
    static func camera(position: SIMD3<Float> = .zero, rotation: simd_quatf = simd_quatf(angle: 0, axis: SIMD3(0, 1, 0))) -> CameraPose {
        CameraPose(position: Point3(position), quaternion: Rotation4(rotation))
    }
    @MainActor static func main() async throws {
        guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Coverage tests require Metal") }
        let pose = TeachingCoveragePose(camera())!
        let flat = try model(plane(z: 1), quad)
        let engine = try TeachingCoverageEngine(model: flat)
        let depths = try await engine.rasterize(pose)
        precondition(depths.count == 28 * 18 && depths.allSatisfy { abs($0 - 1) < 0.00001 },
                     "a large triangle crossing the frustum covers its interior even when every source vertex is outside")
        for point in [SIMD3<Float>(0, 0, 1), SIMD3(0.45, 0.2, 1)] {
            precondition(TeachingCoverageProfile.contains(point, depths: depths))
        }
        for point in [SIMD3<Float>(0.7, 0, 1), SIMD3(0, 0.5, 1), SIMD3(0, 0, -1), SIMD3(0, 0, 1.4), SIMD3(0, 0, 0.2)] {
            precondition(!TeachingCoverageProfile.contains(point, depths: depths), "FOV, front direction and M70 range are enforced")
        }
        let stacked = try model(plane(z: 0.7, radius: 0.15) + plane(z: 1), quad + quad.map { $0 + 4 })
        let stackedEngine = try TeachingCoverageEngine(model: stacked)
        let occlusion = try await stackedEngine.rasterize(pose)
        precondition(TeachingCoverageProfile.contains(SIMD3(0, 0, 0.7), depths: occlusion))
        precondition(!TeachingCoverageProfile.contains(SIMD3(0, 0, 1), depths: occlusion), "rear surfaces cannot leak through the foreground")
        precondition(TeachingCoverageProfile.contains(SIMD3(0.4, 0, 1), depths: occlusion), "visible rear surface beside an occluder remains covered")
        let tooNear = try model(plane(z: 0.1) + plane(z: 1), quad + quad.map { $0 + 4 })
        let nearEngine = try TeachingCoverageEngine(model: tooNear)
        let nearGrid = try await nearEngine.rasterize(pose)
        precondition(!TeachingCoverageProfile.contains(SIMD3(0, 0, 1), depths: nearGrid),
                     "occluders closer than M70 workingNear must still block surfaces behind them")
        let emptyEngine = try TeachingCoverageEngine(model: model(plane(z: 2), quad))
        let empty = try await emptyEngine.rasterize(pose)
        precondition(empty.allSatisfy { $0 == 0 }, "empty cells never extend to the far plane")
        let missing = try await emptyEngine.build([pose])
        precondition(missing.frameCount == 0 && missing.frames == nil)

        let q = simd_quatf(angle: 0.76, axis: simd_normalize(SIMD3<Float>(1, 2, 3)))
        let movedPose = TeachingCoveragePose(camera(position: SIMD3(0.8, -0.3, 0.4), rotation: q))!
        let fromCamera = movedPose.cameraFromModel.inverse
        let rotated = plane(z: 1).map { p -> SIMD3<Float> in
            let v = fromCamera * SIMD4(p, 1); return SIMD3(v.x, v.y, v.z)
        }
        let rotatedEngine = try TeachingCoverageEngine(model: model(rotated, quad))
        let rotatedGrid = try await rotatedEngine.rasterize(movedPose)
        precondition(rotatedGrid.allSatisfy { abs($0 - 1) < 0.00001 }, "arbitrary model-relative camera tilt and translation retain the footprint")

        let point = SIMD3((Float(14.5 / 28 * 2 - 1)) * TeachingCoverageProfile.tangentX,
                          (Float(9.5 / 18 * 2 - 1)) * TeachingCoverageProfile.tangentY, 1)
        let pointEngine = try TeachingCoverageEngine(model: model([point], []))
        let pointGrid = try await pointEngine.rasterize(pose)
        precondition(TeachingCoverageProfile.contains(point, depths: pointGrid), "legacy point-only models are supported")
        for malformed in [try model(plane(z: 1), [0, 1, 99]), try model([SIMD3(.nan, 0, 1)], [])] {
            let invalidEngine = try TeachingCoverageEngine(model: malformed)
            do { _ = try await invalidEngine.rasterize(pose); fatalError("invalid model geometry must not produce coverage") }
            catch is TeachingError {}
        }
        var invalidCamera = camera(); invalidCamera.position.x = .nan
        precondition(TeachingCoveragePose(invalidCamera) == nil)

        // Exercise the actual SceneKit Metal shader and read rendered pixels:
        // this catches buffer bindings, interpolation and union/opacity errors.
        let renderer = SCNRenderer(device: device, options: nil)
        let scene = SCNScene(); scene.background.contents = NSColor.black
        let geometry = try flat.makeGeometry(settings: ModelDisplaySettings(meshQuality: .full))
        let node = SCNNode(geometry: geometry); scene.rootNode.addChildNode(node)
        let cameraNode = SCNNode(); cameraNode.camera = SCNCamera()
        cameraNode.camera?.usesOrthographicProjection = true; cameraNode.camera?.orthographicScale = 1.2
        cameraNode.position = SCNVector3(0, 0, 3); scene.rootNode.addChildNode(cameraNode)
        renderer.scene = scene; renderer.pointOfView = cameraNode
        func capture(_ filename: String? = nil) -> [UInt8] {
            let shot = renderer.snapshot(atTime: 0, with: CGSize(width: 256, height: 256), antialiasingMode: .none)
            let cg = shot.cgImage(forProposedRect: nil, context: nil, hints: nil)!
            var pixels = [UInt8](repeating: 0, count: 256 * 256 * 4)
            pixels.withUnsafeMutableBytes { raw in
                let context = CGContext(data: raw.baseAddress, width: 256, height: 256, bitsPerComponent: 8,
                    bytesPerRow: 1024, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
                context.draw(cg, in: CGRect(x: 0, y: 0, width: 256, height: 256))
            }
            if let filename, let directory = CommandLine.arguments.dropFirst().first {
                try! NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])!
                    .write(to: URL(fileURLWithPath: directory).appendingPathComponent(filename))
            }
            return pixels
        }
        let plain = capture()
        let snapshot = try await engine.build([pose])
        TeachingCoverageRenderer.apply(snapshot, opacity: 0.5, to: geometry.firstMaterial!)
        let tinted = capture("coverage-surface.png")
        let center = (128 * 256 + 128) * 4
        precondition(Int(tinted[center + 1]) > Int(tinted[center]) + 30, "the real shader must tint the triangle interior green")
        precondition(tinted[center + 3] == plain[center + 3], "source alpha is preserved")
        let outside = (128 * 256 + 240) * 4
        precondition(Array(tinted[outside..<(outside + 4)]) == Array(plain[outside..<(outside + 4)]), "outside-FOV surface color remains unchanged")
        let repeated = try await engine.build([pose, pose])
        TeachingCoverageRenderer.apply(repeated, opacity: 0.5, to: geometry.firstMaterial!)
        let overlapped = capture()
        precondition(Array(overlapped[center..<(center + 4)]) == Array(tinted[center..<(center + 4)]), "overlapping poses are a binary union, never darker or brighter")
        node.geometry = try stacked.makeGeometry(settings: ModelDisplaySettings(meshQuality: .full))
        let stackedSnapshot = try await stackedEngine.build([pose])
        let backPlain = capture()
        TeachingCoverageRenderer.apply(stackedSnapshot, opacity: 0.5, to: node.geometry!.firstMaterial!)
        let backTinted = capture("coverage-occlusion.png")
        precondition(Array(backPlain[center..<(center + 4)]) == Array(backTinted[center..<(center + 4)]), "a view from behind must not reveal tint through the model")

        let display = TeachingCoverageRenderer()
        let sample = TeachingSample(segmentId: "test", kind: "keyframe", cameraPose: camera())
        display.attach(to: geometry); display.update(model: flat, samples: [sample, sample])
        for _ in 0..<500 { if !display.preparing { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        precondition(display.error.isEmpty && !display.preparing && display.poseCount == 2 && display.hitCount == 1)
        let another = TeachingSample(segmentId: "another-segment", kind: "keyframe", cameraPose: camera(position: SIMD3(0.1, 0, 0)))
        display.update(model: flat, samples: [sample, sample, another])
        precondition(display.hitCount == 1 && geometry.firstMaterial!.shaderModifiers != nil,
                     "adding a pose retains the previous union while the new footprint is being prepared")
        display.cancel(); display.resume()
        for _ in 0..<500 { if !display.preparing { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        precondition(display.error.isEmpty && !display.preparing && display.hitCount == 2,
                     "foreground resume must finish a pending footprint even if an older union is already visible")
        let replacement = try flat.makeGeometry(settings: ModelDisplaySettings(mode: .points))
        display.attach(to: replacement)
        precondition(replacement.firstMaterial!.shaderModifiers != nil && display.hitCount == 2,
                     "quality or render-mode changes reuse the same full-model coverage")
        display.attach(to: geometry)
        display.enabled = false
        precondition(geometry.firstMaterial!.shaderModifiers == nil, "hiding coverage restores original rendering")
        display.enabled = true
        display.update(model: flat, samples: [])
        try await Task.sleep(nanoseconds: 100_000_000)
        precondition(display.poseCount == 0 && display.hitCount == 0 && geometry.firstMaterial!.shaderModifiers == nil,
                     "deleting the last pose cancels stale work and clears the surface")
        print("M70 surface coverage: full-model GPU occlusion, near occluders, FOV/range, arbitrary tilt, sparse triangles, point clouds, invalid input, shader pixels, binary union and delete/cancel passed.")
    }
}
