import XCTest
import CryptoKit
import UIKit
import SceneKit
import SwiftUI

@MainActor
final class AtlasTeachingUITests: XCTestCase {
    func testSpatialAxesAlignmentRendering() throws {
        func reading(_ angle: Float) -> SpatialLevelReading {
            SpatialLevelReading.measure(screenFromWorld: simd_float4x4(simd_quatf(angle: angle * .pi / 180, axis: SIMD3(0, 0, 1))).inverse)!
        }
        let cases: [(String, SpatialLevelReading?, Bool)] = [
            ("Upright", reading(0), true), ("Inclusive 1.50 degree boundary", reading(1.5), true),
            ("Outside 1.51 degree boundary", reading(1.51), false), ("Tilted 35 degrees", reading(35), false),
            ("Inverted 180 degrees", reading(180), false), ("Tracking unavailable", nil, false)
        ]
        for (name, value, expectedGreen) in cases {
            let renderer = ImageRenderer(content: SpatialLevelView(reading: value).frame(width: 232)
                .environment(\.colorScheme, .dark).padding(16).background(Color.black))
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.uiImage)
            let cgImage = try XCTUnwrap(image.cgImage)
            let colorSpace = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
            let context = try XCTUnwrap(CGContext(data: nil, width: cgImage.width, height: cgImage.height,
                bitsPerComponent: 8, bytesPerRow: cgImage.width * 4, space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height))
            let pixels = try XCTUnwrap(context.data).assumingMemoryBound(to: UInt8.self)
            let offset = ((cgImage.height / 2) * cgImage.width + 24 * 2) * 4
            let red = Double(pixels[offset]), green = Double(pixels[offset + 1]), blue = Double(pixels[offset + 2])
            XCTAssertEqual(green > red * 1.5 && green > blue * 1.5, expectedGreen,
                "\(name): the card itself is green only when gravity alignment is valid")
            let attachment = XCTAttachment(image: image)
            attachment.name = "Device axes - \(name)"; attachment.lifetime = .keepAlways; add(attachment)
        }
    }

    func testPoseSwipeAndBulkDeletion() throws {
        continueAfterFailure = false
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_REVIEW_FIXTURE_ID"],
              UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable project with at least six Poses for deletion testing")
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launch()
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        let review = app.buttons["review-poses"]
        XCTAssertTrue(review.waitForExistence(timeout: 30)); review.tap()
        let close = app.buttons["close-pose-review"]
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        let count = app.staticTexts["pose-review-count"]
        let initialCount = try XCTUnwrap(Int(count.label.split(separator: " ").first ?? ""))
        XCTAssertGreaterThanOrEqual(initialCount, 6)
        func expectCount(_ expected: Int) {
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "label BEGINSWITH %@", "\(expected) "), object: count)], timeout: 5), .completed)
        }
        func screenshot(_ name: String) {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        }
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "review-pose-"))
        let firstID = rows.element(boundBy: 0).identifier
        let secondID = rows.element(boundBy: 1).identifier
        let thirdID = rows.element(boundBy: 2).identifier
        let first = app.buttons[firstID]
        first.swipeLeft()
        let swipeDelete = app.buttons["swipe-delete-pose-\(firstID.dropFirst("review-pose-".count))"]
        XCTAssertTrue(swipeDelete.waitForExistence(timeout: 5))
        expectCount(initialCount)
        XCTAssertTrue(first.exists, "even a full left swipe only reveals the delete button")
        screenshot("Left swipe reveals single Pose delete")
        swipeDelete.tap()
        expectCount(initialCount - 1)
        XCTAssertFalse(first.exists)
        XCTAssertTrue(app.otherElements["pose-review-preview"].exists, "deleting the current Pose selects a remaining preview")

        let enter = app.buttons["delete-review-pose"], bulk = app.buttons["delete-selected-poses"]
        let all = app.buttons["select-all-poses"], selectedCount = app.staticTexts["selected-poses-count"]
        enter.tap()
        XCTAssertTrue(all.waitForExistence(timeout: 5))
        XCTAssertEqual(selectedCount.label, "已选 0/\(initialCount - 1)")
        XCTAssertFalse(bulk.isEnabled)
        expectCount(initialCount - 1)
        app.buttons[secondID].tap(); app.buttons[thirdID].tap()
        XCTAssertEqual(selectedCount.label, "已选 2/\(initialCount - 1)")
        XCTAssertEqual(app.buttons[secondID].value as? String, "已勾选")
        XCTAssertEqual(app.buttons[thirdID].value as? String, "已勾选")
        screenshot("Landscape Pose selection")
        app.buttons["cancel-pose-selection"].tap()
        expectCount(initialCount - 1)
        XCTAssertFalse(all.exists)
        XCTAssertTrue(app.buttons[secondID].exists); XCTAssertTrue(app.buttons[thirdID].exists)

        enter.tap()
        XCTAssertEqual(selectedCount.label, "已选 0/\(initialCount - 1)", "cancel clears selection without deleting")
        all.tap()
        XCTAssertEqual(selectedCount.label, "已选 \(initialCount - 1)/\(initialCount - 1)", "select all includes offscreen rows")
        XCTAssertEqual(all.value as? String, "已全选")
        app.buttons[thirdID].tap()
        XCTAssertEqual(selectedCount.label, "已选 \(initialCount - 2)/\(initialCount - 1)")
        XCTAssertEqual(all.value as? String, "部分选择")
        all.tap(); XCTAssertEqual(all.value as? String, "已全选")
        all.tap(); XCTAssertEqual(all.value as? String, "未选择")
        XCTAssertFalse(bulk.isEnabled)
        app.buttons[secondID].tap(); app.buttons[thirdID].tap()
        XCUIDevice.shared.orientation = .portrait
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.windows.firstMatch.frame.height > app.windows.firstMatch.frame.width
        }, object: nil)], timeout: 10), .completed)
        XCTAssertTrue(all.isHittable); XCTAssertTrue(bulk.isHittable)
        XCTAssertEqual(selectedCount.label, "已选 2/\(initialCount - 1)")
        screenshot("Portrait Pose selection")
        bulk.tap()
        expectCount(initialCount - 3)
        XCTAssertFalse(app.buttons[secondID].exists); XCTAssertFalse(app.buttons[thirdID].exists)
        XCTAssertFalse(all.exists)
        XCTAssertTrue(app.otherElements["pose-review-preview"].exists)
        close.tap()
        app.buttons["本地项目"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        app.terminate(); app.launch()
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        XCTAssertTrue(review.waitForExistence(timeout: 30)); review.tap()
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        expectCount(initialCount - 3)
        XCTAssertFalse(app.buttons[firstID].exists)
        XCTAssertFalse(app.buttons[secondID].exists); XCTAssertFalse(app.buttons[thirdID].exists)
        XCTAssertFalse(all.exists, "selection mode does not persist across sessions")

        enter.tap(); all.tap(); bulk.tap()
        expectCount(0)
        XCTAssertTrue(app.staticTexts["还没有 Pose"].exists)
        XCTAssertFalse(app.otherElements["pose-review-preview"].exists)
        XCTAssertFalse(all.exists); XCTAssertFalse(enter.exists)
        screenshot("Pose review after deleting all")
        close.tap()
        XCTAssertFalse(review.isEnabled)
        app.buttons["本地项目"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 10))
    }

    func testPoseLeftSwipeAcrossRowAndRefresh() throws {
        continueAfterFailure = false
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_REVIEW_FIXTURE_ID"], UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable Pose project for swipe regression")
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launch()
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        XCTAssertTrue(app.buttons["display-settings"].waitForExistence(timeout: 30))
        // Reproduce the user's full-resolution Mesh rather than just the opening preview.
        app.buttons["display-settings"].tap()
        let quality = app.buttons["mesh-quality"]
        XCTAssertTrue(quality.waitForExistence(timeout: 10)); quality.tap(); app.buttons["全量"].tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"),
            object: app.progressIndicators["model-render-progress"])], timeout: 60), .completed)
        app.buttons["close-display-settings"].tap()
        app.buttons["review-poses"].tap()
        let close = app.buttons["close-pose-review"]
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        let count = app.staticTexts["pose-review-count"].label
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "review-pose-"))
        let ids = (0..<2).map { rows.element(boundBy: $0).identifier }
        for (index, startX) in [0.92, 0.6, 0.35].enumerated() {
            let row = app.buttons[ids[index % 2]]
            row.tap()
            let rowFrame = row.frame
            let start = row.coordinate(withNormalizedOffset: CGVector(dx: startX, dy: 0.5))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: -72, dy: 0)),
                withVelocity: .slow, thenHoldForDuration: 0.1)
            let action = app.buttons["swipe-delete-pose-\(row.identifier.dropFirst("review-pose-".count))"]
            XCTAssertTrue(action.waitForExistence(timeout: 5), "left swipe starting at \(startX) must reveal delete")
            XCTAssertTrue(action.isHittable)
            let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == false"), object: action)
            hidden.isInverted = true
            XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 1.5), .completed,
                "background AR attitude updates must not close the swipe action")
            XCTAssertEqual(app.staticTexts["pose-review-count"].label, count, "swiping never deletes")
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "Slow left swipe from row \(startX)"; attachment.lifetime = .keepAlways; add(attachment)
            // Once revealed, the native cell extends offscreen; use its original visible position to close it.
            let closeStart = app.coordinate(withNormalizedOffset: .zero).withOffset(
                CGVector(dx: rowFrame.minX + rowFrame.width * 0.3, dy: rowFrame.midY))
            closeStart.press(forDuration: 0.05, thenDragTo: closeStart.withOffset(CGVector(dx: 100, dy: 0)),
                withVelocity: .slow, thenHoldForDuration: 0.1)
            XCTAssertFalse(action.isHittable)
        }
        close.tap()
        app.buttons["本地项目"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 10))
    }

    func testFullScreenPoseReviewLayoutEditingAndReturn() throws {
        continueAfterFailure = false
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_REVIEW_FIXTURE_ID"],
              UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable project with at least two Poses for full-screen review testing")
        }
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication(); app.launch()
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        let aid = app.switches["ground-assistance"]
        XCTAssertTrue(aid.waitForExistence(timeout: 30)); aid.tap()
        let place = app.buttons["place-model"], confirm = app.buttons["confirm-model-calibration"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: place)], timeout: 30), .completed)
        app.otherElements["teaching-render-surface"].coordinate(withNormalizedOffset: CGVector(dx: 0.48, dy: 0.7)).tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: confirm)], timeout: 15), .completed)
        confirm.tap()
        let capture = app.buttons["capture-pose"]
        XCTAssertTrue(capture.isEnabled)
        app.buttons["review-poses"].tap()
        let page = app.otherElements["pose-review-page"], viewport = app.otherElements["pose-review-viewport"]
        let preview = app.otherElements["pose-review-preview"], close = app.buttons["close-pose-review"]
        XCTAssertTrue(close.waitForExistence(timeout: 10)); XCTAssertTrue(page.exists)
        func checkFullScreen(_ orientation: UIDeviceOrientation) {
            XCUIDevice.shared.orientation = orientation
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                let frame = app.windows.firstMatch.frame
                return orientation.isLandscape ? frame.width > frame.height : frame.height > frame.width
            }, object: nil)], timeout: 10), .completed)
            let window = app.windows.firstMatch.frame
            XCTAssertEqual(page.frame.width, window.width, accuracy: 2, "review must use the full app width")
            XCTAssertGreaterThan(page.frame.height, window.height * 0.8, "review must fill the screen below its toolbar")
            XCTAssertTrue(window.contains(close.frame)); XCTAssertTrue(close.isHittable)
            XCTAssertTrue(preview.exists); XCTAssertGreaterThan(preview.frame.width, 300)
            if orientation.isLandscape {
                XCTAssertGreaterThan(viewport.frame.width, window.width * 0.7)
                XCTAssertGreaterThan(viewport.frame.height, window.height * 0.8)
            } else {
                XCTAssertEqual(viewport.frame.width, window.width, accuracy: 2, "portrait preview spans the whole row")
            }
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = "Full-screen Pose review \(orientation.isLandscape ? "landscape" : "portrait")"
            screenshot.lifetime = .keepAlways; add(screenshot)
        }
        checkFullScreen(.portrait)
        let name = app.textFields["review-pose-name"]
        XCTAssertTrue(name.exists); name.tap()
        let priorName = name.value as? String ?? ""
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: priorName.count) + "Review renamed Pose")
        XCTAssertEqual(name.value as? String, "Review renamed Pose")
        app.buttons["save-pose-name"].tap()
        let renamed = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "review-pose-", "Review renamed Pose")).firstMatch
        XCTAssertTrue(renamed.exists, "rename updates the list without leaving review")
        checkFullScreen(.landscapeLeft)
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "review-pose-"))
        XCTAssertGreaterThanOrEqual(rows.count, 2)
        let secondID = rows.element(boundBy: 1).identifier
        app.buttons[secondID].tap()
        XCTAssertFalse(preview.label.contains("Review renamed Pose"), "selecting another Pose changes the preview")
        app.buttons["delete-review-pose"].tap()
        app.buttons[secondID].tap()
        app.buttons["delete-selected-poses"].tap()
        XCTAssertFalse(app.buttons[secondID].exists, "delete updates the list immediately")
        XCTAssertTrue(renamed.exists)
        close.tap()
        XCTAssertTrue(capture.waitForExistence(timeout: 10))
        XCTAssertTrue(capture.isEnabled, "returning from full-screen review must preserve calibration and rendering")
        XCTAssertTrue(app.buttons["adjust-model-placement"].exists)
        app.buttons["review-poses"].tap()
        XCTAssertTrue(close.waitForExistence(timeout: 10)); XCTAssertTrue(renamed.exists)
        XCTAssertFalse(app.buttons[secondID].exists, "edits survive closing and reopening review")
        close.tap()
        XCTAssertTrue(capture.isEnabled)
        app.buttons["本地项目"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 10))
    }

    func testFullScreenPoseReviewBackgroundRequiresRecalibration() throws {
        continueAfterFailure = false
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_REVIEW_FIXTURE_ID"],
              UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable Pose review fixture for the hardware lifecycle test")
        }
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication(); app.launch()
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        let aid = app.switches["ground-assistance"]
        XCTAssertTrue(aid.waitForExistence(timeout: 30)); aid.tap()
        let place = app.buttons["place-model"], confirm = app.buttons["confirm-model-calibration"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: place)], timeout: 30), .completed)
        app.otherElements["teaching-render-surface"].coordinate(withNormalizedOffset: CGVector(dx: 0.48, dy: 0.7)).tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: confirm)], timeout: 15), .completed)
        confirm.tap()
        XCTAssertTrue(app.buttons["capture-pose"].isEnabled)
        app.buttons["review-poses"].tap()
        let close = app.buttons["close-pose-review"]
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        XCTAssertTrue(app.otherElements["pose-review-preview"].exists)
        close.tap()
        XCTAssertFalse(app.buttons["capture-pose"].isEnabled, "backgrounding during review still requires recalibration")
        XCTAssertTrue(place.waitForExistence(timeout: 10))
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: place)], timeout: 30), .completed,
            "the live camera must resume so the user can recalibrate")
        app.buttons["本地项目"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 10))
    }

    func testNearbyPoseConfirmationOnDevice() throws {
        continueAfterFailure = false
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_PROXIMITY_FIXTURE_ID"],
              UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable empty fixture for the Pose proximity hardware test")
        }
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication(); app.launch()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.windows.firstMatch.frame.height > app.windows.firstMatch.frame.width
        }, object: nil)], timeout: 10), .completed)
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        let aid = app.switches["ground-assistance"]
        XCTAssertTrue(aid.waitForExistence(timeout: 15)); aid.tap()
        let place = app.buttons["place-model"], confirm = app.buttons["confirm-model-calibration"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: place)], timeout: 30), .completed)
        app.otherElements["teaching-render-surface"].coordinate(withNormalizedOffset: CGVector(dx: 0.48, dy: 0.7)).tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: confirm)], timeout: 15), .completed)
        confirm.tap()
        let capture = app.buttons["capture-pose"], alert = app.alerts["当前 Pose 与上一个距离很近"]
        XCTAssertTrue(capture.isEnabled); capture.tap()
        XCTAssertFalse(alert.exists, "the first Pose must record directly")
        app.buttons["collapse-teaching-panel"].tap()
        let count = app.staticTexts["floating-pose-count"]
        XCTAssertEqual(count.label, "1 个 Pose")
        capture.tap(); XCTAssertTrue(alert.waitForExistence(timeout: 5))
        XCTAssertTrue(alert.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "小于 10 cm")).firstMatch.exists)
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Nearby Pose distance confirmation"; screenshot.lifetime = .keepAlways; add(screenshot)
        alert.buttons["取消"].tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: alert)], timeout: 5), .completed)
        XCTAssertEqual(count.label, "1 个 Pose", "cancel does not append a Pose")
        capture.tap(); XCTAssertTrue(alert.waitForExistence(timeout: 5)); alert.buttons["仍然记录"].tap()
        XCTAssertEqual(count.label, "2 个 Pose", "confirmation appends exactly one Pose")

        app.buttons["expand-teaching-panel"].tap()
        capture.tap(); XCTAssertTrue(alert.waitForExistence(timeout: 5)); alert.buttons["取消"].tap()
        capture.tap(); XCTAssertTrue(alert.waitForExistence(timeout: 5)); alert.buttons["仍然记录"].tap()
        app.buttons["collapse-teaching-panel"].tap()
        XCTAssertEqual(count.label, "3 个 Pose", "expanded and collapsed buttons share the same confirmation")
        capture.tap(); XCTAssertTrue(alert.waitForExistence(timeout: 5))
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(capture.waitForExistence(timeout: 10))
        XCTAssertFalse(alert.exists, "backgrounding discards an unconfirmed capture")
        XCTAssertFalse(capture.isEnabled, "resume still requires recalibration")
        XCTAssertEqual(count.label, "3 个 Pose")
        app.buttons["expand-teaching-panel"].tap()
        app.buttons["本地项目"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 10))
    }

    func testFrozenPoseCommitRequiresCurrentCalibrationAndAcceptedSave() throws {
        let ar = ARController()
        var calibrations: [Calibration] = [], accepted: [TeachingSample] = []
        ar.onCalibration = { calibrations.append($0) }
        ar.onSample = { sample in
            guard !accepted.contains(where: { $0.id == sample.id }) else { return false }
            accepted.append(sample); return true
        }
        ar.trackingNormal = true
        ar.applyPlacement(at: SIMD3(0, -1, -2)); ar.confirmCalibration()
        let calibration = try XCTUnwrap(calibrations.last)
        let sample = TeachingSample(segmentId: calibration.id, kind: "keyframe",
            cameraPose: CameraPose(position: Point3(SIMD3(0.03, 0.04, 0)), quaternion: Rotation4(simd_quatf())),
            surfacePoint: Point3(SIMD3(1, 2, 3)), previewCameraTransform: matrix_identity_float4x4.elements,
            previewProjection: matrix_identity_float4x4.elements, previewAspect: 4.0 / 3.0)
        let previous = TeachingSample(segmentId: calibration.id, kind: "keyframe",
            cameraPose: CameraPose(position: Point3(.zero), quaternion: Rotation4(simd_quatf())))
        let confirmation = try XCTUnwrap(NearbyPoseConfirmation(sample: sample, previousSample: previous))
        XCTAssertTrue(accepted.isEmpty, "preparing an alert cannot save a sample")
        let model = try XCTUnwrap(ar.view.scene.rootNode.childNode(withName: "independent-teaching-object", recursively: true))
        let root = try XCTUnwrap(model.parent)
        let markerRoot = try XCTUnwrap(root.childNodes.first { $0 !== model && $0.name != "virtual-origin-axes" })
        XCTAssertTrue(markerRoot.childNodes.isEmpty, "pending/cancelled poses have no marker")
        root.simdPosition += SIMD3(0.5, 0, 0)
        ar.recordKeyframe(confirmation.sample)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        XCTAssertEqual(try encoder.encode(accepted.first), try encoder.encode(Optional(sample)),
            "a later AR transform must not change the captured pose or preview")
        XCTAssertEqual(markerRoot.childNodes.count, 1)
        ar.recordKeyframe(confirmation.sample)
        XCTAssertEqual(accepted.count, 1); XCTAssertEqual(markerRoot.childNodes.count, 1, "rejected saves add no duplicate marker")

        var next = sample; next.id = UUID().uuidString
        ar.trackingNormal = false; ar.recordKeyframe(next)
        XCTAssertEqual(accepted.count, 1, "tracking loss blocks a pending confirmation")
        ar.trackingNormal = true; ar.beginPlacementAdjustment(); ar.recordKeyframe(next)
        XCTAssertEqual(accepted.count, 1, "placement adjustment blocks recording")
        ar.confirmCalibration(); ar.recordKeyframe(next)
        XCTAssertEqual(accepted.count, 1, "recalibration invalidates the old sample")
        next.segmentId = try XCTUnwrap(calibrations.last?.id)
        ar.onSample = { _ in false }; ar.recordKeyframe(next)
        XCTAssertEqual(markerRoot.childNodes.count, 1, "a failed save cannot show a recorded marker")
        ar.onSample = { accepted.append($0); return true }
        ar.suspend(); ar.recordKeyframe(next)
        XCTAssertEqual(accepted.count, 1, "suspension invalidates a pending sample")
    }

    func testAdjustingCalibratedPlacementCanCommitOrCancel() {
        let ar = ARController()
        var calibrations: [Calibration] = []
        ar.onCalibration = { calibrations.append($0) }
        ar.trackingNormal = true
        ar.referenceX = 2; ar.referenceY = 3; ar.referenceZ = 0.5
        ar.yaw = 42; ar.roll = 30; ar.pitch = -25
        ar.applyPlacement(at: SIMD3(0.3, -1, -2)); ar.confirmCalibration()
        XCTAssertTrue(ar.calibrated); XCTAssertEqual(calibrations.count, 1)
        let root = ar.view.scene.rootNode.childNode(withName: "independent-teaching-object", recursively: true)!.parent!
        root.simdOrientation = simd_quatf(angle: 0.03, axis: SIMD3(0, 1, 0)) * root.simdOrientation
        root.simdPosition += SIMD3(0.02, 0.01, -0.01)
        let original = root.simdTransform

        ar.beginPlacementAdjustment()
        XCTAssertTrue(ar.adjustingPlacement); XCTAssertFalse(ar.calibrated); XCTAssertFalse(root.isHidden)
        XCTAssertEqual(root.simdTransform.elements, original.elements, "unlocking must not move the model")
        ar.yaw = 70; ar.roll = 10; ar.pitch = 15; ar.referenceX = 1
        ar.applyPlacement(at: SIMD3(1.2, -1, -3))
        XCTAssertTrue(ar.adjustingPlacement, "a new hit is still a draft until confirmed")
        ar.beginRepositioning()
        ar.confirmCalibration()
        XCTAssertEqual(calibrations.count, 1, "selection cannot commit the hidden old placement")
        ar.cancelPlacementAdjustment()
        XCTAssertFalse(ar.adjustingPlacement); XCTAssertFalse(ar.repositioning); XCTAssertTrue(ar.calibrated)
        XCTAssertFalse(root.isHidden); XCTAssertEqual(root.simdTransform.elements, original.elements)
        XCTAssertEqual(ar.yaw, 42); XCTAssertEqual(ar.roll, 30); XCTAssertEqual(ar.pitch, -25)
        XCTAssertEqual(ar.referenceX, 2); XCTAssertEqual(calibrations.count, 1, "cancel adds no calibration")

        ar.beginPlacementAdjustment()
        let hit = SIMD3<Float>(0.8, -1, -3)
        ar.applyPlacement(at: hit)
        let rotation = root.simdTransform
        for column in 0..<3 {
            for row in 0..<3 { XCTAssertEqual(rotation[column][row], original[column][row], accuracy: 0.00001) }
        }
        let reference = rotation * SIMD4<Float>(2, 3, 0.5, 1)
        XCTAssertEqual(reference.x, hit.x, accuracy: 0.00001)
        XCTAssertEqual(reference.y, hit.y, accuracy: 0.00001)
        XCTAssertEqual(reference.z, hit.z, accuracy: 0.00001)
        ar.confirmCalibration()
        XCTAssertTrue(ar.calibrated); XCTAssertFalse(ar.adjustingPlacement)
        XCTAssertEqual(calibrations.count, 2); XCTAssertNotEqual(calibrations[0].id, calibrations[1].id)
        XCTAssertEqual(calibrations[1].worldFromModel, root.simdTransform.elements)
        ar.beginPlacementAdjustment(); ar.suspend(); ar.cancelPlacementAdjustment()
        XCTAssertFalse(ar.calibrated); XCTAssertFalse(ar.adjustingPlacement); XCTAssertFalse(ar.placed)
        XCTAssertTrue(root.isHidden, "cancellation cannot restore an anchor after the AR session is lost")
    }

    func testAdjustPlacementWhileTeachingWithoutLeavingPage() throws {
        continueAfterFailure = false
        let app = XCUIApplication(); app.launch()
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .landscapeLeft }
        // Deliberately never fall back to the user's project: this test records
        // Poses, and requires a disposable copy installed for hardware testing.
        let project = app.buttons["local-project-8ADA580F-DC16-4ABD-A420-5AB5C5D30872"]
        guard project.waitForExistence(timeout: 15) else { throw XCTSkip("Install a disposable adjustment fixture before this hardware test") }
        project.tap()
        let aid = app.switches["ground-assistance"], surface = app.otherElements["teaching-render-surface"]
        XCTAssertTrue(aid.waitForExistence(timeout: 15)); aid.tap()
        let place = app.buttons["place-model"], confirm = app.buttons["confirm-model-calibration"]
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: place)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 30), .completed)
        surface.coordinate(withNormalizedOffset: CGVector(dx: 0.48, dy: 0.7)).tap()
        let placed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: confirm)
        XCTAssertEqual(XCTWaiter.wait(for: [placed], timeout: 15), .completed)
        confirm.tap()
        let adjust = app.buttons["adjust-model-placement"], capture = app.buttons["capture-pose"]
        XCTAssertTrue(adjust.waitForExistence(timeout: 5)); XCTAssertTrue(adjust.isHittable)
        func recordPose() {
            capture.tap()
            let nearby = app.alerts["当前 Pose 与上一个距离很近"]
            if nearby.waitForExistence(timeout: 1) { nearby.buttons["仍然记录"].tap() }
        }
        recordPose() // First Pose at the original confirmed placement.
        app.buttons["collapse-teaching-panel"].tap()
        XCTAssertTrue(adjust.isHittable)
        let initialCount = app.staticTexts["floating-pose-count"].label
        let originalFrame = surface.frame
        adjust.tap()
        let cancel = app.buttons["cancel-placement-adjustment"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 5))
        XCTAssertEqual(confirm.label, "确认位置，继续示教")
        XCTAssertFalse(capture.exists, "pose capture is replaced by explicit confirmation during editing")
        XCTAssertEqual(surface.frame, originalFrame, "editing does not resize the camera")
        surface.coordinate(withNormalizedOffset: CGVector(dx: 0.58, dy: 0.74)).tap()
        XCTAssertEqual(app.staticTexts["floating-pose-count"].label, initialCount)
        confirm.tap()
        XCTAssertTrue(adjust.waitForExistence(timeout: 5)); XCTAssertTrue(capture.isEnabled)
        recordPose() // Second Pose must use the new calibration segment.
        let countAfterMove = app.staticTexts["floating-pose-count"].label
        XCTAssertNotEqual(countAfterMove, initialCount)

        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait] {
            XCUIDevice.shared.orientation = orientation
            adjust.tap()
            XCTAssertTrue(cancel.waitForExistence(timeout: 5)); XCTAssertTrue(confirm.isHittable)
            XCTAssertTrue(app.windows.firstMatch.frame.contains(cancel.frame))
            if orientation.isLandscape {
                surface.coordinate(withNormalizedOffset: CGVector(dx: 0.46, dy: 0.68)).tap()
            }
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = "Adjust placement during teaching \(orientation.rawValue)"; screenshot.lifetime = .keepAlways; add(screenshot)
            cancel.tap()
            XCTAssertTrue(adjust.waitForExistence(timeout: 5)); XCTAssertTrue(capture.isEnabled)
            XCTAssertEqual(app.staticTexts["floating-pose-count"].label, countAfterMove)
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        recordPose() // Cancellation resumes the second calibration segment.
        app.buttons["expand-teaching-panel"].tap()
        XCTAssertTrue(adjust.isHittable, "the expanded panel has a fixed, visible adjustment entry")
        adjust.tap()
        XCTAssertTrue(cancel.waitForExistence(timeout: 5)); XCTAssertTrue(confirm.isHittable)
        cancel.tap()
        app.buttons["本地项目"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 10))
    }

    func testRepositioningRetainsPlacementUntilValidTarget() {
        let ar = ARController()
        var calibrationWrites = 0, poseWrites = 0
        ar.onCalibration = { _ in calibrationWrites += 1 }
        ar.onSample = { _ in poseWrites += 1; return true }
        ar.trackingNormal = true
        ar.referenceX = 2; ar.referenceY = 3; ar.referenceZ = 0.5
        ar.yaw = 42; ar.roll = 30; ar.pitch = -25
        let oldHit = SIMD3<Float>(0.3, -1, -2), newHit = SIMD3<Float>(0.8, -1, -3)
        ar.applyPlacement(at: oldHit)
        let root = ar.view.scene.rootNode.childNode(withName: "independent-teaching-object", recursively: true)!.parent!
        // AR can refine a confirmed anchor before the user unlocks calibration.
        // Cancellation must retain that actual transform, not the original hit.
        root.simdPosition += SIMD3(0.02, 0.01, -0.01)
        let original = root.simdTransform
        XCTAssertFalse(ar.groundTargetAvailable)
        XCTAssertTrue(ar.placementActionEnabled, "an existing model can be repositioned even when the center misses the floor")

        ar.trackingNormal = false
        XCTAssertTrue(ar.placementActionEnabled, "entering selection does not move the model or require a tracked hit")
        ar.beginRepositioning()
        XCTAssertTrue(ar.repositioning); XCTAssertTrue(root.isHidden)
        XCTAssertFalse(ar.placementActionEnabled, "committing a target still needs normal tracking")
        ar.applyPlacement(at: newHit)
        XCTAssertTrue(ar.repositioning)
        XCTAssertEqual(root.simdTransform.elements, original.elements)
        ar.trackingNormal = true
        ar.applyPlacement(at: SIMD3(.nan, -1, -2))
        ar.placeObject() // No camera frame/ground hit in this isolated controller.
        ar.confirmCalibration(); XCTAssertNil(ar.captureKeyframe())
        XCTAssertTrue(ar.repositioning); XCTAssertFalse(ar.calibrated)
        XCTAssertFalse(ar.placementActionEnabled, "no observed floor means no placement at the center")
        ar.cancelRepositioning()
        XCTAssertFalse(ar.repositioning); XCTAssertFalse(root.isHidden)
        XCTAssertEqual(root.simdTransform.elements, original.elements, "cancel restores the exact previous placement")
        XCTAssertTrue(ar.placementActionEnabled)

        ar.beginRepositioning()
        ar.updatePlacement()
        XCTAssertTrue(root.isHidden, "UI refreshes cannot reveal the old model while selecting")
        ar.applyPlacement(at: newHit)
        XCTAssertFalse(ar.repositioning); XCTAssertFalse(root.isHidden)
        let expected = TeachingCoordinates.placement(hit: newHit, reference: SIMD3(2, 3, 0.5), yaw: 42, roll: 30, pitch: -25)
        XCTAssertEqual(root.simdTransform.elements, expected.elements)
        XCTAssertNotEqual(root.simdTransform.elements, original.elements, "a valid second hit really moves the model")
        XCTAssertEqual(ar.yaw, 42); XCTAssertEqual(ar.roll, 30); XCTAssertEqual(ar.pitch, -25)
        ar.calibrated = true
        ar.beginRepositioning(); ar.applyPlacement(at: oldHit)
        XCTAssertFalse(ar.repositioning); XCTAssertFalse(ar.placementActionEnabled)
        XCTAssertEqual(root.simdTransform.elements, expected.elements, "calibrated models require an explicit unlock")
        ar.beginCalibration(); ar.beginRepositioning(); ar.suspend()
        XCTAssertFalse(ar.placed); XCTAssertFalse(ar.repositioning); XCTAssertTrue(root.isHidden)
        XCTAssertEqual(calibrationWrites, 0); XCTAssertEqual(poseWrites, 0)
    }

    func testLiveModelRepositioningAndCancel() throws {
        continueAfterFailure = false
        let app = XCUIApplication(); app.launch()
        XCUIDevice.shared.orientation = .landscapeLeft
        let project = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "local-project-")).firstMatch
        guard project.waitForExistence(timeout: 15) else { throw XCTSkip("Requires a local unfinished model on a LiDAR iPad") }
        project.tap()
        let aid = app.switches["ground-assistance"], place = app.buttons["place-model"]
        XCTAssertTrue(aid.waitForExistence(timeout: 15))
        // Use measured depth for a repeatable live placement; then enable floor
        // assistance to verify that re-entering selection is never floor-gated.
        aid.tap()
        let tracked = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: place)
        XCTAssertEqual(XCTWaiter.wait(for: [tracked], timeout: 30), .completed)
        let surface = app.otherElements["teaching-render-surface"]
        surface.coordinate(withNormalizedOffset: CGVector(dx: 0.48, dy: 0.7)).tap()
        let confirm = app.buttons["confirm-model-calibration"]
        let placed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: confirm)
        XCTAssertEqual(XCTWaiter.wait(for: [placed], timeout: 15), .completed)
        XCTAssertEqual(place.label, "重新放置物体")
        aid.tap()
        XCTAssertTrue(place.isEnabled)
        place.tap()
        let cancel = app.buttons["cancel-model-repositioning"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 5))
        XCTAssertEqual(place.label, "放到准星位置")
        XCTAssertFalse(confirm.isEnabled)
        XCTAssertFalse(app.buttons["capture-pose"].isEnabled)
        XCTAssertNotEqual(app.staticTexts["spatial-level-angle"].label, "—", "device attitude remains available during model relocation")
        cancel.tap()
        XCTAssertFalse(cancel.exists); XCTAssertTrue(confirm.isEnabled); XCTAssertTrue(place.isEnabled)
        XCTAssertEqual(place.label, "重新放置物体")
        let restored = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        restored.name = "Cancel relocation restores the existing model"; restored.lifetime = .keepAlways; add(restored)

        place.tap()
        XCTAssertTrue(cancel.waitForExistence(timeout: 5))
        aid.tap()
        XCTAssertTrue(place.isEnabled)
        place.tap()
        // The center may be a reflective/distant surface. A rejected hit must
        // retain selection; a successful hit may be followed by another move.
        if !cancel.exists { place.tap() }
        XCTAssertTrue(cancel.waitForExistence(timeout: 5))
        surface.coordinate(withNormalizedOffset: CGVector(dx: 0.58, dy: 0.74)).tap()
        XCTAssertFalse(cancel.exists, "scene taps must pass through the toolbar's transparent area")
        XCTAssertTrue(confirm.isEnabled)
        XCTAssertEqual(place.label, "重新放置物体")
        let moved = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        moved.name = "Model placed again from measured depth"; moved.lifetime = .keepAlways; add(moved)
        XCTAssertFalse(app.buttons["capture-pose"].isEnabled)
        // No calibration confirmation or Pose writes in the user's project.
        app.buttons["本地项目"].tap()
    }

    func testTeachingSurfaceCoverageControlsAndPreview() throws {
        continueAfterFailure = false
        let app = XCUIApplication(); app.launch()
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .landscapeLeft }
        let project = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "local-project-")).firstMatch
        guard project.waitForExistence(timeout: 15) else { throw XCTSkip("Requires a local model with recorded Poses") }
        project.tap()
        let toggle = app.switches["teaching-coverage-toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        XCTAssertEqual(toggle.value as? String, "1")
        let status = app.staticTexts["teaching-coverage-status"]
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            status.label.contains("表面覆盖已更新") || status.label.contains("未命中模型") || status.label.contains("记录 Pose 后")
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 60), .completed, status.label)
        let initialStatus = status.label
        XCTAssertFalse(app.buttons["capture-pose"].isEnabled, "displaying old footprints cannot calibrate or capture")
        let intensity = app.sliders["teaching-coverage-opacity"]
        intensity.adjust(toNormalizedSliderPosition: 1)
        func snapshot(_ name: String) {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        }
        snapshot("Coverage controls with recorded poses")
        app.buttons["display-settings"].tap()
        XCTAssertTrue(app.buttons["close-display-settings"].waitForExistence(timeout: 10))
        snapshot("Surface coverage on the actual local model")
        app.buttons["close-display-settings"].tap()
        toggle.tap()
        XCTAssertEqual(status.label, "已隐藏")
        XCTAssertFalse(intensity.exists)
        app.buttons["display-settings"].tap()
        XCTAssertTrue(app.buttons["close-display-settings"].waitForExistence(timeout: 10))
        snapshot("Original local model with coverage hidden")
        app.buttons["close-display-settings"].tap()
        toggle.tap()
        let restored = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", initialStatus), object: status)
        XCTAssertEqual(XCTWaiter.wait(for: [restored], timeout: 30), .completed)
        intensity.adjust(toNormalizedSliderPosition: 0.364)
        app.buttons["collapse-teaching-panel"].tap()
        XCTAssertTrue(app.buttons["expand-teaching-panel"].waitForExistence(timeout: 5))
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(app.buttons["capture-pose"].exists)
        XCTAssertFalse(app.buttons["capture-pose"].isEnabled)
        app.buttons["expand-teaching-panel"].tap()
        XCTAssertEqual(toggle.value as? String, "1")
        XCTAssertEqual(status.label, initialStatus)
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(toggle.waitForExistence(timeout: 15))
        XCTAssertEqual(status.label, initialStatus, "camera restart retains model-relative coverage")
        app.buttons["本地项目"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 10))
    }

    private func ipv4Address(in app: XCUIApplication) -> String {
        (0..<4).map { index in
            let field = app.textFields["server-address-octet-\(index)"]
            return field.value as? String ?? ""
        }.joined(separator: ".")
    }

    func testSegmentedIPv4InputLimitsAndNavigation() {
        continueAfterFailure = false
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launchArguments = ["-serverAddress", "http://192.168.100.7:22001"]
        app.launch()
        let fields = (0..<4).map { app.textFields["server-address-octet-\($0)"] }
        XCTAssertTrue(fields[0].waitForExistence(timeout: 15))
        XCTAssertEqual(ipv4Address(in: app), "192.168.100.7")
        let code = app.textFields["pairing-code"], receive = app.buttons["receive-model"]
        code.tap(); code.typeText("Q7Z2")
        fields[0].tap(); fields[0].typeText("10.")
        fields[1].typeText("256")
        XCTAssertEqual(fields[1].value as? String, "25", "reject the digit that would make an octet exceed 255")
        XCTAssertTrue(app.staticTexts["server-address-error"].exists)
        fields[1].typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 2))
        XCTAssertFalse(receive.isEnabled, "an empty octet makes the address incomplete")
        fields[1].typeText(XCUIKeyboardKey.delete.rawValue)
        XCTAssertEqual(fields[0].value as? String, "1", "backspace from an empty cell edits the preceding octet")
        fields[0].typeText("92")
        fields[1].typeText("168.")
        fields[2].typeText("0.")
        fields[3].typeText("255")
        XCTAssertEqual(ipv4Address(in: app), "192.168.0.255", "three digits advance once; the following dot must not skip an octet")
        XCTAssertTrue(receive.isEnabled)
        fields[3].typeText("6")
        XCTAssertEqual(fields[3].value as? String, "255", "a fourth digit cannot change the valid octet")
        fields[3].typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 3)); fields[3].typeText("0")
        XCTAssertEqual(ipv4Address(in: app), "192.168.0.0")
        XCTAssertTrue(receive.isEnabled, "zero is a valid octet")
        XCTAssertEqual(app.textFields["server-port"].value as? String, "22001", "octet editing preserves the port")
        app.buttons["完成"].tap()
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Segmented IPv4 with independent port"; screenshot.lifetime = .keepAlways; add(screenshot)
        XCTAssertFalse(app.buttons["capture-pose"].exists)
    }

    func testSegmentedIPv4WholeAddressEditIsAtomic() {
        // Exercise UIKit's whole-string edit transaction without relying on a
        // background UI-test runner having access to the device clipboard.
        let view = IPv4InputView(frame: CGRect(x: 0, y: 0, width: 260, height: 44))
        view.setHost("192.168.100.7")
        let fields = view.subviews.compactMap { $0 as? UITextField }
        XCTAssertEqual(fields.count, 4)
        var updates: [String] = [], error = ""
        view.onChange = { updates.append($0) }
        view.onReject = { error = $0 }
        func paste(_ value: String) {
            let first = fields[0]
            XCTAssertEqual(first.delegate?.textField?(first,
                shouldChangeCharactersIn: NSRange(location: 0, length: (first.text ?? "").utf16.count),
                replacementString: value), false)
        }
        paste(" 010.002.003.255 ")
        XCTAssertEqual(updates, ["10.2.3.255"])
        XCTAssertEqual(fields.map { $0.text ?? "" }, ["10", "2", "3", "255"])
        for invalid in ["10.2.3.256", "10.2..3", "10.2.3.4.5", "10.a.3.4", "10.2.3.9999"] {
            paste(invalid)
            XCTAssertFalse(error.isEmpty)
            XCTAssertEqual(updates, ["10.2.3.255"], "a rejected paste must never publish a partial address")
            XCTAssertEqual(fields.map { $0.text ?? "" }, ["10", "2", "3", "255"])
        }
        paste("0.0.0.0")
        XCTAssertEqual(updates.last, "0.0.0.0")
        paste("255.255.255.255")
        XCTAssertEqual(updates.last, "255.255.255.255")
    }

    func testPairingScannerCanCancelWithoutChangingManualInput() {
        continueAfterFailure = false
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launchArguments = ["-serverAddress", "http://192.168.100.7:21990"]
        app.launch()
        let code = app.textFields["pairing-code"]
        XCTAssertTrue(code.waitForExistence(timeout: 15))
        app.buttons["scan-pairing-code"].tap()
        let cancel = app.buttons["cancel-pairing-scan"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 10))
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.alerts.buttons.matching(NSPredicate(format: "label IN %@", ["允许", "好", "OK", "Allow"])).firstMatch
        if allow.waitForExistence(timeout: 3) { allow.tap() }
        XCTAssertTrue(app.staticTexts["scanner-status"].exists)
        #if !targetEnvironment(simulator)
        XCTAssertFalse(app.staticTexts["scanner-camera-help"].exists, "The connected iPad Pro must display the real camera scanner")
        #endif
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "Native QR pairing scanner"; shot.lifetime = .keepAlways; add(shot)
        cancel.tap()
        XCTAssertTrue(code.waitForExistence(timeout: 5))
        // VisionKit can restore the physical device orientation after dismissal.
        // Wait for the rotation before editing so the next tap uses stable coordinates.
        XCUIDevice.shared.orientation = .portrait
        let portrait = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let frame = app.windows.firstMatch.frame
            return frame.height > frame.width
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [portrait], timeout: 10), .completed)
        code.tap(); code.typeText("Q7Z2")
        app.buttons["scan-pairing-code"].tap()
        XCTAssertTrue(cancel.waitForExistence(timeout: 10))
        cancel.tap()
        XCTAssertTrue(code.waitForExistence(timeout: 5))
        XCTAssertEqual(code.value as? String, "Q7Z2")
        XCTAssertEqual(ipv4Address(in: app), "192.168.100.7")
        XCTAssertEqual(app.textFields["server-port"].value as? String, "21990")
        XCTAssertTrue(app.buttons["receive-model"].isEnabled)
        XCTAssertFalse(app.buttons["capture-pose"].exists)
        XCUIDevice.shared.orientation = .landscapeLeft
    }

    func testDiscoverTeachingServerKeepsPairingCode() throws {
        guard let serverID = ProcessInfo.processInfo.environment["ATLAS_DISCOVERY_SERVER_ID"] else {
            throw XCTSkip("Provide the running LAN service ID for a physical discovery test")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launchArguments = ["-serverAddress", "http://192.168.100.7:21990"]
        app.launch()
        let code = app.textFields["pairing-code"]
        XCTAssertTrue(code.waitForExistence(timeout: 15))
        code.tap(); code.typeText("Q7Z2")
        let service = app.buttons["discovered-service-\(serverID)"]
        XCTAssertTrue(service.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(ipv4Address(in: app), "192.168.100.7", "search never overwrites a manually entered address")
        service.tap()
        XCTAssertNotEqual(ipv4Address(in: app), "192.168.100.7")
        XCTAssertEqual(code.value as? String, "Q7Z2", "selection keeps the pairing code")
        XCTAssertTrue(app.buttons["receive-model"].isEnabled)
        XCTAssertFalse(app.buttons["capture-pose"].exists, "discovery never pairs or opens a teaching session")
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Discovered LAN teaching server, pairing still required"; screenshot.lifetime = .keepAlways; add(screenshot)
    }

    func testFourCharacterPairingInput() {
        continueAfterFailure = false
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launchArguments = ["-serverAddress", "http://192.168.0.233:21990"]
        app.launch()
        let code = app.textFields["pairing-code"], receive = app.buttons["receive-model"]
        XCTAssertTrue(code.waitForExistence(timeout: 15))
        XCTAssertFalse(receive.isEnabled)
        code.tap(); code.typeText("q7z")
        XCTAssertEqual(code.value as? String, "Q7Z")
        XCTAssertFalse(receive.isEnabled, "three characters are incomplete")
        code.typeText("2")
        XCTAssertEqual(code.value as? String, "Q7Z2")
        XCTAssertTrue(receive.isEnabled, "uppercase letters beyond F are supported")
        let filled = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        filled.name = "Four filled pairing code cells"; filled.lifetime = .keepAlways; add(filled)
        code.typeText("9")
        XCTAssertFalse(receive.isEnabled, "do not truncate a pasted longer code into a different valid code")
        code.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5))
        code.typeText("1234"); XCTAssertTrue(receive.isEnabled, "digits-only codes are supported")
        code.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 4))
        code.typeText("wxyz"); XCTAssertEqual(code.value as? String, "WXYZ"); XCTAssertTrue(receive.isEnabled)
        code.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 4))
        code.typeText("12-4"); XCTAssertFalse(receive.isEnabled, "punctuation is rejected")
        code.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 4))
        XCTAssertFalse(app.buttons["capture-pose"].exists, "input validation never pairs by itself")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "Four-character alphanumeric pairing input"; shot.lifetime = .keepAlways; add(shot)
    }

    func testSeparateIPv4AndPortInputs() {
        continueAfterFailure = false
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launchArguments = ["-serverAddress", "192.168.100.7"]
        app.launch()
        let host = app.textFields["server-address-octet-0"], port = app.textFields["server-port"]
        XCTAssertTrue(host.waitForExistence(timeout: 15))
        XCTAssertEqual(ipv4Address(in: app), "192.168.100.7")
        XCTAssertEqual(port.value as? String, "21990")
        app.textFields["pairing-code"].tap(); app.textFields["pairing-code"].typeText("Q7Z2")
        let receive = app.buttons["receive-model"]
        XCTAssertTrue(receive.isEnabled)
        port.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        port.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5)); port.typeText("22001")
        XCTAssertEqual(ipv4Address(in: app), "192.168.100.7", "editing the port keeps the IPv4 address")
        XCTAssertEqual(port.value as? String, "22001"); XCTAssertTrue(receive.isEnabled)
        port.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5)); port.typeText("65536")
        XCTAssertFalse(receive.isEnabled)
        port.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5))
        XCTAssertTrue(receive.isEnabled, "a blank port uses 21990")
        port.typeText("21990\n")
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "IPv4 address and default port"; screenshot.lifetime = .keepAlways; add(screenshot)
        XCTAssertFalse(app.buttons["capture-pose"].exists)
    }

    func testLocalModelThumbnailLoadsWithoutOpeningProject() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launch()
        let project = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "local-project-")).firstMatch
        guard project.waitForExistence(timeout: 15) else { throw XCTSkip("Requires a locally received model") }
        let id = String(project.identifier.dropFirst("local-project-".count))
        let preview = app.images["model-thumbnail-\(id)"]
        XCTAssertTrue(preview.waitForExistence(timeout: 45), app.debugDescription)
        XCTAssertTrue(project.frame.contains(preview.frame), "The thumbnail stays inside its model card")
        XCTAssertFalse(app.buttons["capture-pose"].exists, "Generating a thumbnail must not open or calibrate the project")
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Local model card with actual cached preview"; screenshot.lifetime = .keepAlways; add(screenshot)
        app.terminate(); app.launch()
        XCTAssertTrue(preview.waitForExistence(timeout: 15), "The preview remains available after relaunch")
        XCTAssertFalse(app.buttons["capture-pose"].exists)
    }

    func testLibraryFillsWindowAndAdaptsToRotation() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.textFields["server-address-octet-0"].waitForExistence(timeout: 15))
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait] {
            XCUIDevice.shared.orientation = orientation
            let rotated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                let window = app.windows.firstMatch.frame
                return orientation.isLandscape ? window.width > window.height : window.height > window.width
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [rotated], timeout: 10), .completed)
            let pairing = app.otherElements["library-pairing-panel"]
            let projects = app.otherElements["library-projects-panel"]
            XCTAssertTrue(pairing.waitForExistence(timeout: 5))
            XCTAssertTrue(projects.exists)
            let window = app.windows.firstMatch.frame
            let left = pairing.frame, right = projects.frame
            if window.width >= 1000 && window.width > window.height {
                XCTAssertEqual(left.minY, right.minY, accuracy: 2)
                XCTAssertGreaterThan(right.minX, left.maxX)
                XCTAssertLessThanOrEqual(window.maxX - right.maxX, 32, "Use the width of the iPad instead of a centered fixed-width column")
            } else {
                XCTAssertGreaterThan(right.minY, left.maxY)
                XCTAssertEqual(left.width, right.width, accuracy: 2)
                XCTAssertLessThanOrEqual(window.maxX - left.maxX, 32)
            }
            XCTAssertLessThanOrEqual(left.minX - window.minX, 32)
            XCTAssertTrue(window.contains(app.buttons["receive-model"].frame))
            print("Library window: \(window), pairing panel: \(left), project panel: \(right)")
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = orientation.isLandscape ? "Full-width library landscape" : "Full-width library portrait"
            screenshot.lifetime = .keepAlways; add(screenshot)
        }
        XCUIDevice.shared.orientation = .landscapeLeft
    }

    func testCollapsibleTeachingPanelAndFloatingPose() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .landscapeLeft }
        let project = ProcessInfo.processInfo.environment["ATLAS_HARDWARE_SESSION"].map {
            app.buttons["local-project-\($0)"]
        } ?? app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "local-project-")).firstMatch
        guard project.waitForExistence(timeout: 15) else { throw XCTSkip("Requires a locally received model on a LiDAR iPad") }
        project.tap()
        let collapse = app.buttons["collapse-teaching-panel"], expand = app.buttons["expand-teaching-panel"]
        XCTAssertTrue(collapse.waitForExistence(timeout: 15))
        let scene = app.otherElements["teaching-viewport"], capture = app.buttons["capture-pose"]
        guard capture.exists else { throw XCTSkip("Requires an unfinished project") }
        let surface = app.otherElements["teaching-render-surface"]
        let target = app.images["teaching-placement-target"]
        func assertFrame(_ element: XCUIElement, _ expected: CGRect, file: StaticString = #filePath, line: UInt = #line) {
            let actual = element.frame
            XCTAssertEqual(actual.minX, expected.minX, accuracy: 1, file: file, line: line)
            XCTAssertEqual(actual.minY, expected.minY, accuracy: 1, file: file, line: line)
            XCTAssertEqual(actual.width, expected.width, accuracy: 1, file: file, line: line)
            XCTAssertEqual(actual.height, expected.height, accuracy: 1, file: file, line: line)
        }
        func snapshot(_ name: String) {
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = name; screenshot.lifetime = .keepAlways; add(screenshot)
        }
        let originalFrame = scene.frame
        XCTAssertEqual(originalFrame.width, app.windows.firstMatch.frame.width, accuracy: 1)
        assertFrame(surface, originalFrame)
        XCTAssertFalse(expand.exists)
        XCTAssertFalse(app.otherElements["floating-pose-controls"].exists)
        XCTAssertFalse(capture.isEnabled)
        // Without the M70 mask, folding must also preserve the native camera's
        // bounds and center. Covering the image is allowed; changing its crop is not.
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait, .landscapeRight] {
            XCUIDevice.shared.orientation = orientation
            let expandedSurface = surface.frame, expandedTarget = target.frame
            XCTAssertEqual(expandedTarget.midX, expandedSurface.midX, accuracy: 1)
            XCTAssertEqual(expandedTarget.midY, expandedSurface.midY, accuracy: 1)
            snapshot("Stable camera expanded \(orientation.rawValue)")
            collapse.tap()
            XCTAssertTrue(expand.waitForExistence(timeout: 5))
            assertFrame(surface, expandedSurface)
            assertFrame(target, expandedTarget)
            snapshot("Stable camera collapsed \(orientation.rawValue)")
            expand.tap()
            XCTAssertTrue(collapse.waitForExistence(timeout: 5))
            assertFrame(surface, expandedSurface)
            assertFrame(target, expandedTarget)
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        let maskToggle = app.switches["zivid-fov-toggle"]
        maskToggle.tap()
        let aperture = app.otherElements["zivid-fov-aperture"]
        XCTAssertTrue(aperture.waitForExistence(timeout: 10))
        let originalAperture = aperture.frame, maskedSurface = surface.frame

        // Place without confirming calibration or writing a Pose. This catches
        // accidental AR/view recreation during the layout change.
        var placed = false, tilt = ""
        let place = app.buttons["place-model"]
        let floorReady = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: place)
        if XCTWaiter.wait(for: [floorReady], timeout: 10) == .completed {
            app.buttons["model-tilt-controls"].tap()
            app.sliders["model-pitch"].adjust(toNormalizedSliderPosition: 0.54)
            tilt = app.staticTexts["model-pitch-value"].label
            place.tap()
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: app.buttons["confirm-model-calibration"])
            placed = XCTWaiter.wait(for: [ready], timeout: 10) == .completed
        }
        XCTAssertTrue(collapse.isHittable, "the fixed header stays available when the panel is scrolled")
        collapse.tap()
        XCTAssertTrue(expand.waitForExistence(timeout: 5))
        XCTAssertFalse(collapse.isHittable, "the retained sidebar cannot receive touches while folded")
        XCTAssertEqual(app.buttons.matching(identifier: "capture-pose").count, 1)
        XCTAssertTrue(app.otherElements["floating-pose-controls"].exists)
        assertFrame(scene, originalFrame)
        assertFrame(surface, maskedSurface)
        assertFrame(aperture, originalAperture)
        let count = app.staticTexts["floating-pose-count"].label
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait] {
            XCUIDevice.shared.orientation = orientation
            let rotated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                let window = app.windows.firstMatch.frame
                return orientation.isLandscape ? window.width > window.height : window.height > window.width
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [rotated], timeout: 10), .completed)
            let window = app.windows.firstMatch.frame
            XCTAssertEqual(scene.frame.width, window.width, accuracy: 2)
            XCTAssertTrue(window.contains(capture.frame))
            XCTAssertGreaterThan(capture.frame.midX, window.midX)
            XCTAssertGreaterThan(capture.frame.midY, window.height * 0.75)
            XCTAssertLessThan(window.maxX - capture.frame.maxX, 55)
            XCTAssertFalse(capture.isEnabled, "collapsing cannot bypass calibration")
            XCTAssertTrue(expand.isHittable)
            XCTAssertEqual(app.staticTexts["floating-pose-count"].label, count)
            XCTAssertEqual(aperture.value as? String, "完整视野")
            let collapsedSurface = surface.frame, collapsedAperture = aperture.frame, collapsedTarget = target.frame
            snapshot("Stable M70 camera collapsed \(orientation.rawValue)")
            expand.tap()
            XCTAssertTrue(collapse.waitForExistence(timeout: 5))
            assertFrame(surface, collapsedSurface)
            assertFrame(aperture, collapsedAperture)
            assertFrame(target, collapsedTarget)
            snapshot("Stable M70 camera expanded \(orientation.rawValue)")
            collapse.tap()
            XCTAssertTrue(expand.waitForExistence(timeout: 5))
            assertFrame(surface, collapsedSurface)
            assertFrame(aperture, collapsedAperture)
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        expand.tap()
        XCTAssertTrue(collapse.waitForExistence(timeout: 5))
        assertFrame(scene, originalFrame)
        XCTAssertFalse(app.otherElements["floating-pose-controls"].exists)
        XCTAssertEqual(maskToggle.value as? String, "1", "panel visibility preserves viewfinder settings")
        if placed {
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: app.buttons["confirm-model-calibration"])
            XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 10), .completed, "placement survives collapsing and rotating")
            XCTAssertEqual(app.staticTexts["model-pitch-value"].label, tilt)
        }
        collapse.tap()
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(expand.waitForExistence(timeout: 15))
        XCTAssertFalse(capture.isEnabled, "resuming must still require calibration")
        expand.tap()
        app.buttons["本地项目"].tap()
    }

    func testLightweightOpeningAndManualQuality() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        XCUIDevice.shared.orientation = .landscapeLeft
        let project = ProcessInfo.processInfo.environment["ATLAS_HARDWARE_SESSION"].map {
            app.buttons["local-project-\($0)"]
        } ?? app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "local-project-")).firstMatch
        guard project.waitForExistence(timeout: 15) else { throw XCTSkip("Requires a locally received model") }
        let projectID = project.identifier
        let started = Date()
        project.tap()
        XCTAssertTrue(app.buttons["display-settings"].waitForExistence(timeout: 10))
        print("Model page opened in \(Date().timeIntervalSince(started)) seconds including XCTest tap/idle overhead")
        app.buttons["display-settings"].tap()
        let summary = app.staticTexts["model-render-summary"]
        XCTAssertTrue(summary.waitForExistence(timeout: 10))
        let originalMode = app.buttons["display-mode-points"].isSelected ? "points" : "mesh"
        XCTAssertTrue(app.buttons["point-density"].label.contains("轻量"))
        XCTAssertTrue(app.buttons["mesh-quality"].label.contains("轻量"))
        let mesh = app.buttons["display-mode-mesh"]
        if mesh.isEnabled {
            mesh.tap()
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                summary.label.hasPrefix("Mesh") && !app.progressIndicators["model-render-progress"].exists
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed)
            let light = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            light.name = "Lightweight initial Mesh"; light.lifetime = .keepAlways; add(light)
            let total = summary.label.components(separatedBy: " / ").last!.components(separatedBy: " ").first!
            app.buttons["mesh-quality"].tap(); app.buttons["全量"].tap()
            waitForRenderSummary(app, label: "Mesh · \(total) / \(total) 面")
            let full = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            full.name = "Explicit full-quality Mesh"; full.lifetime = .keepAlways; add(full)
        }
        app.buttons["display-mode-points"].tap()
        app.buttons["point-density"].tap(); app.buttons["25%"].tap()
        let dense = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            summary.label.hasPrefix("点云") && !app.progressIndicators["model-render-progress"].exists
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [dense], timeout: 30), .completed)
        app.buttons["close-display-settings"].tap()
        XCTAssertFalse(app.buttons["capture-pose"].isEnabled, "display upgrades cannot calibrate or create poses")
        app.buttons["本地项目"].tap()
        let reopened = app.buttons[projectID]
        XCTAssertTrue(reopened.waitForExistence(timeout: 10)); reopened.tap()
        XCTAssertTrue(app.buttons["display-settings"].waitForExistence(timeout: 10))
        app.buttons["display-settings"].tap()
        XCTAssertTrue(app.buttons["display-mode-points"].isSelected, "opening retains the last display mode")
        XCTAssertTrue(app.buttons["point-density"].label.contains("轻量"), "reopening must not automatically restore dense points")
        XCTAssertTrue(app.buttons["mesh-quality"].label.contains("轻量"), "reopening must not automatically restore full Mesh")
        app.buttons["display-mode-\(originalMode)"].tap()
        app.buttons["close-display-settings"].tap()
        app.buttons["本地项目"].tap()
    }

    func testZividFieldOfViewMaskAndRotation() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .landscapeLeft }
        app.launch()
        let project = ProcessInfo.processInfo.environment["ATLAS_HARDWARE_SESSION"].map {
            app.buttons["local-project-\($0)"]
        } ?? app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "local-project-")).firstMatch
        guard project.waitForExistence(timeout: 15) else { throw XCTSkip("Requires a locally received model on a LiDAR iPad") }
        project.tap()
        let toggle = app.switches["zivid-fov-toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 60))
        XCTAssertEqual(toggle.value as? String, "0")
        let aperture = app.otherElements["zivid-fov-aperture"]
        XCTAssertFalse(aperture.exists)
        toggle.tap()
        XCTAssertEqual(toggle.value as? String, "1")
        XCTAssertTrue(aperture.waitForExistence(timeout: 15))
        let capture = app.buttons["capture-pose"]
        XCTAssertFalse(capture.isEnabled, "a viewfinder cannot confirm calibration or create poses")
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait, .landscapeRight] {
            XCUIDevice.shared.orientation = orientation
            let rotated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                let frame = aperture.frame
                return frame.width > 0 && (orientation.isLandscape ? frame.width > frame.height : frame.height > frame.width)
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [rotated], timeout: 10), .completed)
            XCTAssertEqual(aperture.value as? String, "完整视野", "the connected iPad camera must cover the full nominal M70 aperture")
            XCTAssertTrue(app.windows.firstMatch.frame.contains(aperture.frame))
            XCTAssertTrue(app.windows.firstMatch.frame.contains(toggle.frame))
            let status = app.staticTexts["zivid-fov-status"]
            XCTAssertTrue(status.label.contains("标称视野参考"))
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = "M70 field of view \(orientation.rawValue)"; screenshot.lifetime = .keepAlways; add(screenshot)
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        toggle.tap()
        XCTAssertFalse(aperture.exists)
        toggle.tap()
        XCTAssertTrue(aperture.waitForExistence(timeout: 10))
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(toggle.waitForExistence(timeout: 15))
        XCTAssertEqual(toggle.value as? String, "1")
        XCTAssertTrue(aperture.waitForExistence(timeout: 15), "camera intrinsics must be refreshed after resuming")
        XCTAssertFalse(capture.isEnabled)
        app.buttons["本地项目"].tap()
    }

    func testGroundAssistanceControlsAndLifecycle() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .landscapeLeft }
        app.launch()
        let project = ProcessInfo.processInfo.environment["ATLAS_HARDWARE_SESSION"].map {
            app.buttons["local-project-\($0)"]
        } ?? app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "local-project-")).firstMatch
        guard project.waitForExistence(timeout: 15) else { throw XCTSkip("Requires a locally received model on a LiDAR iPad") }
        project.tap()
        let aid = app.switches["ground-assistance"], status = app.staticTexts["ground-status"]
        guard aid.waitForExistence(timeout: 60) else { throw XCTSkip("Requires an unfinished project on a LiDAR iPad") }
        XCTAssertEqual(aid.value as? String, "1")
        XCTAssertTrue(status.exists)
        XCTAssertFalse(app.buttons["capture-pose"].isEnabled, "floor detection never calibrates or records automatically")
        aid.tap()
        XCTAssertEqual(aid.value as? String, "0")
        XCTAssertTrue(status.label.contains("已关闭"))
        aid.tap()
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait] {
            XCUIDevice.shared.orientation = orientation
            let rotated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                let window = app.windows.firstMatch.frame
                return orientation.isLandscape ? window.width > window.height : window.height > window.width
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [rotated], timeout: 10), .completed)
            XCTAssertTrue(app.windows.firstMatch.frame.contains(aid.frame))
            XCTAssertTrue(app.windows.firstMatch.frame.contains(status.frame))
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = orientation.isLandscape ? "Ground assistance landscape" : "Ground assistance portrait"
            screenshot.lifetime = .keepAlways; add(screenshot)
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        let place = app.buttons["place-model"]
        let groundReady = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: place)
        if XCTWaiter.wait(for: [groundReady], timeout: 20) == .completed {
            XCTAssertTrue(status.label.contains("准星已对准地面"))
            app.buttons["model-tilt-controls"].tap()
            app.sliders["model-pitch"].adjust(toNormalizedSliderPosition: 0.58)
            let tilt = app.staticTexts["model-pitch-value"].label
            XCTAssertNotEqual(tilt, "0.0°")
            place.tap()
            let confirm = app.buttons["confirm-model-calibration"]
            let placed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: confirm)
            XCTAssertEqual(XCTWaiter.wait(for: [placed], timeout: 10), .completed)
            XCTAssertEqual(app.staticTexts["model-pitch-value"].label, tilt, "floor placement preserves the requested tilt")
            XCTAssertFalse(app.buttons["capture-pose"].isEnabled, "a ground hit still requires explicit calibration")
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = "Live LiDAR floor placement with free tilt"; screenshot.lifetime = .keepAlways; add(screenshot)
            print("Live classified ground target, placement and free tilt verified")
        } else {
            print("Ground controls verified; no classified floor at the center for the live placement check")
        }
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(aid.waitForExistence(timeout: 15))
        XCTAssertEqual(aid.value as? String, "1")
        XCTAssertFalse(app.buttons["capture-pose"].isEnabled)
        XCTAssertFalse(app.buttons["confirm-model-calibration"].isEnabled, "resuming must not reuse a placement from the old AR session")
        app.buttons["本地项目"].tap()
    }

    func testSpatialLevelDeviceAxesAndLifecycle() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .landscapeLeft }
        app.launch()
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_HARDWARE_SESSION"], UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable project for live device attitude testing")
        }
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15))
        project.tap()
        let capture = app.buttons["capture-pose"]
        XCTAssertTrue(capture.waitForExistence(timeout: 60), app.debugDescription)
        let groundAid = app.switches["ground-assistance"]
        if groundAid.exists, groundAid.value as? String == "1" { groundAid.tap() }
        let angle = app.staticTexts["spatial-level-angle"]
        XCTAssertTrue(angle.waitForExistence(timeout: 15))
        let measured = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label != %@", "—"), object: angle)
        XCTAssertEqual(XCTWaiter.wait(for: [measured], timeout: 30), .completed,
            "device attitude is available before model placement")
        XCTAssertFalse(app.buttons["confirm-model-calibration"].isEnabled)
        XCTAssertFalse(capture.isEnabled)
        let toggle = app.buttons["toggle-spatial-level"]
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait] {
            XCUIDevice.shared.orientation = orientation
            let rotated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                let window = app.windows.firstMatch.frame
                return orientation.isLandscape ? window.width > window.height : window.height > window.width
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [rotated], timeout: 10), .completed)
            let window = app.windows.firstMatch.frame
            XCTAssertTrue(window.contains(app.otherElements["spatial-level"].frame))
            XCTAssertTrue(window.contains(toggle.frame))
            toggle.tap(); XCTAssertFalse(angle.exists)
            toggle.tap(); XCTAssertTrue(angle.waitForExistence(timeout: 5))
            XCTAssertTrue(app.staticTexts["X 前  ·  Y 左  ·  Z 上"].exists)
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = orientation.isLandscape ? "Device attitude axes landscape" : "Device attitude axes portrait"
            screenshot.lifetime = .keepAlways; add(screenshot)
        }
        let sidebar = app.scrollViews.firstMatch
        func reveal(_ element: XCUIElement) {
            for _ in 0..<5 {
                if element.exists, element.isHittable,
                   sidebar.frame.insetBy(dx: 0, dy: 16).contains(element.frame) { return }
                sidebar.swipeUp()
            }
            XCTAssertTrue(element.isHittable, "sidebar control must be visible before tapping")
        }
        let tilt = app.buttons["model-tilt-controls"]
        reveal(tilt); tilt.tap()
        let pitch = app.sliders["model-pitch"], roll = app.sliders["model-roll"]
        XCTAssertTrue(pitch.waitForExistence(timeout: 5), app.debugDescription)
        reveal(pitch); pitch.adjust(toNormalizedSliderPosition: 0.6)
        reveal(roll); roll.adjust(toNormalizedSliderPosition: 0.4)
        XCTAssertNotEqual(app.staticTexts["model-pitch-value"].label, "0.0°")
        XCTAssertNotEqual(app.staticTexts["model-roll-value"].label, "0.0°")
        XCTAssertFalse(capture.isEnabled, "The reference aid never calibrates or records automatically")
        let confirm = app.buttons["confirm-model-calibration"]
        XCTAssertFalse(confirm.isEnabled, "device attitude does not invent a model placement")
        let value = Float(angle.label.replacingOccurrences(of: "°", with: ""))
        XCTAssertNotNil(value); XCTAssertTrue((0...180).contains(value ?? -1))
        toggle.tap(); XCTAssertFalse(confirm.isEnabled, "Hiding the reference does not change calibration eligibility")
        toggle.tap()
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Live device axes with freely tilted model"; screenshot.lifetime = .keepAlways; add(screenshot)
        XCUIDevice.shared.press(.home); app.activate()
        let resumed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label != %@", "—"), object: angle)
        XCTAssertEqual(XCTWaiter.wait(for: [resumed], timeout: 30), .completed,
            "device attitude resumes with fresh tracking even though model calibration was reset")
        XCTAssertFalse(capture.isEnabled)
        XCTAssertFalse(confirm.isEnabled)
        // Exit without confirming calibration or creating a Pose in the disposable fixture.
        app.buttons["本地项目"].tap()
    }

    func testHardwareLANAndLiDAR() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let address = environment["ATLAS_HARDWARE_ADDRESS"],
              let pairingCode = environment["ATLAS_HARDWARE_CODE"],
              let name = environment["ATLAS_HARDWARE_MODEL"] else {
            throw XCTSkip("Provide a LAN test fixture to run on a physical LiDAR iPad")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        func allowPermissions() {
            for alert in springboard.alerts.allElementsBoundByIndex {
                let button = alert.buttons.matching(NSPredicate(format: "label IN %@", ["允许", "好", "OK", "Allow"])).firstMatch
                if button.exists { button.tap() }
            }
        }
        addUIInterruptionMonitor(withDescription: "Camera and local network access") { alert in
            let button = alert.buttons.matching(NSPredicate(format: "label IN %@", ["允许", "好", "OK", "Allow"])).firstMatch
            guard button.exists else { return false }
            button.tap(); return true
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launchArguments = ["-serverAddress", address]
        app.launch()
        XCTAssertTrue(app.textFields["server-address-octet-0"].waitForExistence(timeout: 15))
        if environment["ATLAS_HARDWARE_LOCAL_ONLY"] == "1", let id = environment["ATLAS_HARDWARE_SESSION"] {
            let project = app.buttons["local-project-\(id)"]
            XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        } else {
            let code = app.textFields["pairing-code"]
            code.tap(); code.typeText(pairingCode)
            app.buttons["receive-model"].tap()
        }
        let capture = app.buttons["capture-pose"]
        let deadline = Date().addingTimeInterval(120)
        var retriedAfterPermission = false
        while !capture.exists && Date() < deadline {
            allowPermissions()
            if app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "接收失败：")).firstMatch.exists,
               app.buttons["receive-model"].isEnabled {
                if retriedAfterPermission { break }
                retriedAfterPermission = true; app.buttons["receive-model"].tap()
            }
            RunLoop.current.run(until: Date().addingTimeInterval(1))
        }
        XCTAssertTrue(capture.exists, app.debugDescription)
        XCTAssertTrue(app.staticTexts[name].exists)
        allowPermissions()
        XCTAssertTrue(app.staticTexts["LiDAR 已就绪"].waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertFalse(capture.isEnabled, "A real iPad must require calibration before recording")
        XCTAssertTrue(app.windows.firstMatch.frame.contains(capture.frame))
        let workspace = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        workspace.name = "Physical iPad LAN model and LiDAR"; workspace.lifetime = .keepAlways; add(workspace)
        if let vertices = environment["ATLAS_DISPLAY_VERTICES"].flatMap(Int.init),
           let faces = environment["ATLAS_DISPLAY_FACES"].flatMap(Int.init) {
            try verifyDisplaySettings(app, vertices: vertices, faces: faces)
        }
        app.buttons["本地项目"].tap()
        app.terminate(); app.launch()
        let localProject = environment["ATLAS_HARDWARE_SESSION"].map { app.buttons["local-project-\($0)"] } ?? app.staticTexts[name]
        XCTAssertTrue(localProject.waitForExistence(timeout: 15))
        localProject.tap()
        XCTAssertTrue(capture.waitForExistence(timeout: 60))
        XCTAssertTrue(app.staticTexts["LiDAR 已就绪"].waitForExistence(timeout: 30))
        if let vertices = environment["ATLAS_DISPLAY_VERTICES"].flatMap(Int.init),
           let faces = environment["ATLAS_DISPLAY_FACES"].flatMap(Int.init) {
            app.buttons["display-settings"].tap()
            waitForRenderSummary(app, label: "点云 · \(min(vertices, 50_000).formatted()) / \(vertices.formatted()) 点")
            XCTAssertTrue(app.buttons["point-density"].label.contains("轻量"), "opening preserves point mode with a lightweight budget")
            app.buttons["display-mode-mesh"].tap()
            waitForRenderSummary(app, label: "Mesh · \(min(faces, 40_000).formatted()) / \(faces.formatted()) 面")
            app.buttons["mesh-quality"].tap(); app.buttons["自动"].tap()
            app.buttons["close-display-settings"].tap()
            XCTAssertFalse(capture.isEnabled, "display changes never calibrate or record a Pose")
        }
        app.buttons["本地项目"].tap()
    }

    private func waitForRenderSummary(_ app: XCUIApplication, label: String) {
        let summary = app.staticTexts["model-render-summary"]
        XCTAssertTrue(summary.waitForExistence(timeout: 15))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", label), object: summary)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 60), .completed, app.debugDescription)
    }

    private func verifyDisplaySettings(_ app: XCUIApplication, vertices: Int, faces: Int) throws {
        app.buttons["display-settings"].tap()
        XCTAssertTrue(app.buttons["mesh-quality"].waitForExistence(timeout: 10))
        app.buttons["display-mode-mesh"].tap()
        let meshReady = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: app.buttons["mesh-quality"])
        XCTAssertEqual(XCTWaiter.wait(for: [meshReady], timeout: 10), .completed)
        XCTAssertTrue(app.buttons["mesh-quality"].isEnabled)
        XCTAssertFalse(app.buttons["point-density"].isEnabled)
        app.buttons["mesh-quality"].tap(); app.buttons["流畅"].tap()
        waitForRenderSummary(app, label: "Mesh · \(min(faces, 180_000).formatted()) / \(faces.formatted()) 面")
        app.buttons["mesh-quality"].tap(); app.buttons["全量"].tap()
        waitForRenderSummary(app, label: "Mesh · \(faces.formatted()) / \(faces.formatted()) 面")
        let mesh = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        mesh.name = "Current workpiece full source mesh on iPad"; mesh.lifetime = .keepAlways; add(mesh)
        app.buttons["display-mode-points"].tap()
        XCTAssertFalse(app.buttons["mesh-quality"].isEnabled)
        app.buttons["point-density"].tap(); app.buttons["5%"].tap()
        waitForRenderSummary(app, label: "点云 · \(Int(ceil(Double(vertices) * 0.05)).formatted()) / \(vertices.formatted()) 点")
        app.buttons["point-density"].tap(); app.buttons["100%"].tap()
        waitForRenderSummary(app, label: "点云 · \(vertices.formatted()) / \(vertices.formatted()) 点")
        let cloud = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        cloud.name = "Current workpiece point density on iPad"; cloud.lifetime = .keepAlways; add(cloud)
        app.buttons["point-density"].tap(); app.buttons["25%"].tap()
        waitForRenderSummary(app, label: "点云 · \(Int(ceil(Double(vertices) * 0.25)).formatted()) / \(vertices.formatted()) 点")
        app.buttons["close-display-settings"].tap()
    }

    func testReceiveAndReopenOfflineProject() async throws {
        continueAfterFailure = false
        let base = "http://127.0.0.1:21990/__atlas/ipad"
        func request(_ path: String, method: String = "POST", token: String? = nil, body: Data? = nil) async throws -> [String: Any] {
            var request = URLRequest(url: URL(string: base + path)!)
            request.httpMethod = method; request.httpBody = body
            if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
            let (data, response) = try await URLSession.shared.data(for: request)
            XCTAssertTrue((200...299).contains((response as! HTTPURLResponse).statusCode), String(decoding: data, as: UTF8.self))
            return try JSONSerialization.jsonObject(with: data) as! [String: Any]
        }
        var model = Data()
        func append(_ value: UInt32) { var little = value.littleEndian; withUnsafeBytes(of: &little) { model.append(contentsOf: $0) } }
        for header: UInt32 in [0x534c5441, 1, 3, 3, 0, 0, 0, 0] { append(header) }
        for value: Float in [0, 0, 0, 0.5, 0, 0, 0, 0.5, 0] { append(value.bitPattern) }
        model.append(contentsOf: [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255])
        [UInt32(0), 1, 2].forEach { append($0) }
        let name = "iPad UI Test \(UUID().uuidString.prefix(8))"
        let manifest: [String: Any] = ["protocol": "atlas-ipad-teaching/1", "modelHash": SHA256.hash(data: model).map { String(format: "%02x", $0) }.joined(),
            "name": name, "sourceHash": "ui-test-model", "sourceMapId": "ui-test-model", "coordinateFrame": "virtual_origin",
            "distanceUnit": "meter", "verticalAxis": "Z", "vertices": 3, "indices": 3, "sampled": false, "originalVertices": 3, "byteLength": model.count,
            "bounds": ["min": ["x": 0, "y": 0, "z": 0], "max": ["x": 0.5, "y": 0.5, "z": 0]]]
        let ticket = try await request("/sessions", body: JSONSerialization.data(withJSONObject: ["manifest": manifest]))
        let id = ticket["id"] as! String, token = ticket["ownerToken"] as! String
        _ = try await request("/sessions/\(id)/model", method: "PUT", token: token, body: model)
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launch()
        let landscape = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in app.windows.firstMatch.frame.width > app.windows.firstMatch.frame.height }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [landscape], timeout: 10), .completed)
        let address = app.textFields["server-address-octet-0"]
        XCTAssertTrue(address.waitForExistence(timeout: 15))
        address.tap()
        address.typeText("127.0.0.1")
        let port = app.textFields["server-port"]; port.tap()
        if let current = port.value as? String, current != port.placeholderValue { port.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count)) }
        port.typeText("21990\n")
        let code = app.textFields["pairing-code"]; code.tap(); code.typeText(ticket["pairingCode"] as! String)
        app.buttons["receive-model"].tap()
        let capture = app.buttons["capture-pose"]
        XCTAssertTrue(capture.waitForExistence(timeout: 20))
        XCTAssertFalse(capture.isEnabled, "Simulator must not pretend to provide LiDAR poses")
        XCTAssertTrue(app.staticTexts[name].exists)
        XCTAssertTrue(app.windows.firstMatch.frame.contains(capture.frame), "Pose controls must fit inside the application window")
        print("Workspace window: \(app.windows.firstMatch.frame), Pose button: \(capture.frame), screen: \(XCUIScreen.main.screenshot().image.size)")
        let workspace = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); workspace.name = "iPad teaching workspace"; workspace.lifetime = .keepAlways; add(workspace)
        app.buttons["本地项目"].tap()
        XCTAssertTrue(app.staticTexts[name].waitForExistence(timeout: 10))
        app.terminate(); app.launch()
        XCTAssertTrue(app.staticTexts[name].waitForExistence(timeout: 15))
        app.staticTexts[name].tap()
        XCTAssertTrue(capture.waitForExistence(timeout: 15))
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(capture.waitForExistence(timeout: 5))
        XCTAssertTrue(app.windows.firstMatch.frame.contains(capture.frame), "Pose controls must remain visible in portrait")
        let status = try await request("/sessions/\(id)", method: "GET", token: token)
        XCTAssertEqual(status["status"] as? String, "paired", "Opening local work never uploads completion")
        app.buttons["本地项目"].tap()
        let home = XCTAttachment(screenshot: app.screenshot()); home.name = "iPad local library"; home.lifetime = .keepAlways; add(home)
    }
}
