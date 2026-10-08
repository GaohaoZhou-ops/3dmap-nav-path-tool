import XCTest

final class AtlasVisionTeachingUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    private func waitForEntry(_ button: XCUIElement) {
        expectation(for: NSPredicate(format: "enabled == true AND label == %@", "进入空间示教"), evaluatedWith: button)
        waitForExpectations(timeout: 15)
    }
    func testLocalTeachingLifecycle() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["open-demo"].waitForExistence(timeout: 15))
        app.buttons["open-demo"].tap()
        let enter = app.buttons["toggle-space"]
        XCTAssertTrue(enter.waitForExistence(timeout: 15))
        let enabled = NSPredicate(format: "enabled == true")
        expectation(for: enabled, evaluatedWith: enter)
        waitForExpectations(timeout: 20)
        enter.tap()
        let front = app.buttons["place-front"].firstMatch
        XCTAssertTrue(front.waitForExistence(timeout: 20))
        front.tap()
        app.buttons["confirm-placement"].firstMatch.tap()
        let record = app.buttons["record-pose"].firstMatch
        XCTAssertTrue(record.waitForExistence(timeout: 10))
        record.tap()
        XCTAssertTrue(app.staticTexts["pose-count"].label.contains("1"))
        app.buttons["move-demo"].firstMatch.tap()
        record.tap()
        XCTAssertTrue(app.staticTexts["pose-count"].label.contains("2"))
        app.buttons["adjust-model"].firstMatch.tap()
        XCTAssertFalse(app.buttons["record-pose"].firstMatch.exists)
        app.buttons["取消调整"].firstMatch.tap()
        XCTAssertTrue(record.exists)
        enter.tap()
        XCTAssertTrue(app.staticTexts["pose-count"].label.contains("2"))
        waitForEntry(enter)
        enter.tap()
        XCTAssertTrue(front.waitForExistence(timeout: 15))
        XCTAssertFalse(record.exists, "reopening must require calibration")
        enter.tap()
        waitForEntry(enter)
        app.buttons["new-project"].tap()
        XCTAssertTrue(app.buttons["open-demo"].waitForExistence(timeout: 10))
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "空间演练工件")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["pose-count"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["pose-count"].label.contains("2"), "offline draft survives reopening")
        app.buttons["finish-local"].tap()
        app.buttons.matching(NSPredicate(format: "label == %@", "完成并保存在本机")).allElementsBoundByIndex.last!.tap()
        let sync = app.buttons["sync-result"]
        XCTAssertTrue(sync.waitForExistence(timeout: 10))
        XCTAssertFalse(sync.isEnabled, "simulator results must never sync")
        XCTAssertFalse(app.buttons["删除 Pose 001"].exists, "completed samples are immutable")
        waitForEntry(enter); enter.tap()
        XCTAssertTrue(front.waitForExistence(timeout: 15)); front.tap()
        app.buttons["confirm-placement"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["已完成 · 空间回看"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(record.exists, "spatial review cannot append samples")
        enter.tap(); waitForEntry(enter)
    }
}
