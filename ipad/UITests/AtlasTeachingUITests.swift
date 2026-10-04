import XCTest
import CryptoKit
import UIKit

@MainActor
final class AtlasTeachingUITests: XCTestCase {
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

    func testSpatialLevelReferenceAndFreePlacement() throws {
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
        let capture = app.buttons["capture-pose"]
        XCTAssertTrue(capture.waitForExistence(timeout: 60), app.debugDescription)
        let angle = app.staticTexts["spatial-level-angle"]
        XCTAssertTrue(angle.waitForExistence(timeout: 15))
        XCTAssertEqual(angle.label, "—", "No angle is invented before the model is placed")
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
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = orientation.isLandscape ? "Spatial level landscape" : "Spatial level portrait"
            screenshot.lifetime = .keepAlways; add(screenshot)
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        app.buttons["model-tilt-controls"].tap()
        let pitch = app.sliders["model-pitch"], roll = app.sliders["model-roll"]
        XCTAssertTrue(pitch.waitForExistence(timeout: 5), app.debugDescription)
        pitch.adjust(toNormalizedSliderPosition: 0.6)
        roll.adjust(toNormalizedSliderPosition: 0.4)
        XCTAssertNotEqual(app.staticTexts["model-pitch-value"].label, "0.0°")
        XCTAssertNotEqual(app.staticTexts["model-roll-value"].label, "0.0°")
        XCTAssertFalse(capture.isEnabled, "The reference aid never calibrates or records automatically")
        let place = app.buttons["place-model"]
        let tracked = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: place)
        guard XCTWaiter.wait(for: [tracked], timeout: 30) == .completed else {
            app.buttons["本地项目"].tap()
            throw XCTSkip("Reference UI passed; live placement requires normal AR tracking")
        }
        place.tap()
        let measured = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label != %@", "—"), object: angle)
        guard XCTWaiter.wait(for: [measured], timeout: 10) == .completed else {
            app.buttons["本地项目"].tap()
            throw XCTSkip("Reference UI passed; live placement requires an observed surface within LiDAR range")
        }
        let confirm = app.buttons["confirm-model-calibration"]
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: confirm)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 30), .completed,
            "Tilted placement can be confirmed without seeking a level angle")
        let value = Float(angle.label.replacingOccurrences(of: "°", with: ""))
        XCTAssertNotNil(value); XCTAssertTrue((0...90).contains(value ?? -1))
        toggle.tap(); XCTAssertTrue(confirm.isEnabled, "Hiding the reference does not change calibration eligibility")
        toggle.tap()
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Live spatial level with freely tilted model"; screenshot.lifetime = .keepAlways; add(screenshot)
        XCUIDevice.shared.press(.home); app.activate()
        let reset = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "—"), object: angle)
        XCTAssertEqual(XCTWaiter.wait(for: [reset], timeout: 10), .completed,
            "Returning from a paused session must not show an old angle")
        XCTAssertFalse(capture.isEnabled)
        XCTAssertFalse(confirm.isEnabled)
        // Exit without confirming calibration or creating a Pose in the user's draft.
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
            waitForRenderSummary(app, label: "点云 · \(Int(ceil(Double(vertices) * 0.25)).formatted()) / \(vertices.formatted()) 点")
            XCTAssertTrue(app.buttons["point-density"].label.contains("25%"), "local display settings persist after termination")
            app.buttons["display-mode-mesh"].tap()
            waitForRenderSummary(app, label: "Mesh · \(faces.formatted()) / \(faces.formatted()) 面")
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
