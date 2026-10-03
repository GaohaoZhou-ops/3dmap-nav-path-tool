import XCTest
import CryptoKit

@MainActor
final class AtlasTeachingUITests: XCTestCase {
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
        XCTAssertEqual(app.textFields["server-address"].value as? String, "http://192.168.100.7:21990", "search never overwrites a manually entered address")
        service.tap()
        XCTAssertNotEqual(app.textFields["server-address"].value as? String, "http://192.168.100.7:21990")
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

    func testLibraryFillsWindowAndAdaptsToRotation() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.textFields["server-address"].waitForExistence(timeout: 15))
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
        XCTAssertTrue(app.textFields["server-address"].waitForExistence(timeout: 15))
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
        let address = app.textFields["server-address"]
        XCTAssertTrue(address.waitForExistence(timeout: 15))
        address.tap()
        if let current = address.value as? String, current.hasPrefix("http") { address.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count)) }
        address.typeText("http://127.0.0.1:21990")
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
