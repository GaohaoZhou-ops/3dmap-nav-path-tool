import Foundation
import Vision
import ImageIO
import CoreGraphics

@main struct QRCodeTests {
    static func main() async throws {
        let args = CommandLine.arguments
        let file = URL(fileURLWithPath: args[1]), address = args[2], sessionID = args[3], serverID = args[4]
        // Decode the real server PNG with Apple's barcode recognizer, including
        // the actual 248-pixel display size used by the desktop pairing dialog.
        let source = CGImageSourceCreateWithURL(file as CFURL, nil)!
        let original = CGImageSourceCreateImageAtIndex(source, 0, nil)!
        let canvas = CGContext(data: nil, width: 248, height: 248, bitsPerComponent: 8, bytesPerRow: 248 * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        canvas.interpolationQuality = .none
        canvas.draw(original, in: CGRect(x: 0, y: 0, width: 248, height: 248))
        let small = canvas.makeImage()!
        func read(_ request: VNImageRequestHandler) throws -> String {
            let detect = VNDetectBarcodesRequest(); detect.symbologies = [.qr]
            try request.perform([detect])
            guard let value = detect.results?.first?.payloadStringValue else { throw TeachingError("Generated QR image is unreadable") }
            return value
        }
        let text = try read(VNImageRequestHandler(url: file))
        let smallText = try read(VNImageRequestHandler(cgImage: small))
        precondition(smallText == text)
        let qr = try PairingQRCode.parse(text)
        precondition(qr.address == address && qr.sessionId == sessionID && qr.serverId == serverID)
        let fields = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
        precondition(fields["ownerToken"] == nil && fields["deviceToken"] == nil, "QR must never expose long-lived credentials")
        func changed(_ key: String, _ value: Any) throws -> String {
            var next = fields; next[key] = value
            return String(decoding: try JSONSerialization.data(withJSONObject: next), as: UTF8.self)
        }
        var invalid = ["https://example.com", "{}", String(repeating: "x", count: 2049),
            try changed("protocol", "other/1"), try changed("expiresAt", 1),
            try changed("code", "ABCDE"), try changed("sessionId", "not-a-session")]
        for address in ["https://example.com", "http://8.8.8.8", "http://192.168.1.2@outside.com",
                        "http://192.168.1.2/path", "http://192.168.1.a.2", "http://192..168.1.2", "http://192.168.1.2:99999"] {
            invalid.append(try changed("address", address))
        }
        for value in invalid {
            do { _ = try PairingQRCode.parse(value); preconditionFailure("Invalid QR was accepted") }
            catch is TeachingError {}
        }
        let client = try LANClient(address: address), deviceID = UUID().uuidString
        for field in ["serverId", "sessionId"] {
            let wrong = try PairingQRCode.parse(changed(field, UUID().uuidString.lowercased()))
            do { _ = try await client.pair(code: wrong.code, deviceID: deviceID, name: "QR Test", qr: wrong); preconditionFailure("Mismatched identity was paired") }
            catch is TeachingError {}
        }
        let paired = try await client.pair(code: qr.code, deviceID: deviceID, name: "QR Test", qr: qr)
        precondition(paired.id == sessionID)
        let downloaded = try await client.download(paired)
        let expected = try Data(contentsOf: URL(fileURLWithPath: args[5]))
        precondition(downloaded == expected)
        print("Apple Vision decoded server QR at full and display resolution; native validation, pairing and model download passed.")
    }
}
