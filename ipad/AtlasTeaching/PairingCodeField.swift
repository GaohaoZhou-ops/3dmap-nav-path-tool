import SwiftUI
import UIKit

// One native input owns the edit transaction; four labels only draw its value.
// Normalizing inside the delegate avoids losing keystrokes during SwiftUI updates.
struct PairingCodeField: UIViewRepresentable {
    @Binding var code: String
    @Binding var isFocused: Bool

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }
    func makeUIView(context: Context) -> CodeTextField {
        let field = CodeTextField()
        field.delegate = context.coordinator
        field.accessibilityIdentifier = "pairing-code"
        field.accessibilityLabel = "4 位配对码"
        field.accessibilityHint = "输入四位大写字母或数字"
        return field
    }
    func updateUIView(_ field: CodeTextField, context: Context) {
        context.coordinator.parent = self
        if field.text != code { field.text = code }
        field.isEnabled = context.environment.isEnabled
        if isFocused && !field.isFirstResponder && field.window != nil { field.becomeFirstResponder() }
        else if !isFocused && field.isFirstResponder { field.resignFirstResponder() }
        field.refreshCells()
    }

    @MainActor final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: PairingCodeField
        init(parent: PairingCodeField) { self.parent = parent }
        func textField(_ field: UITextField, shouldChangeCharactersIn range: NSRange, replacementString replacement: String) -> Bool {
            let current = field.text ?? ""
            guard let editRange = Range(range, in: current) else { return false }
            let next = PairingCode.normalize(current.replacingCharacters(in: editRange, with: replacement))
            let prefix = PairingCode.normalize(String(current[..<editRange.lowerBound]) + replacement)
            field.text = next
            if let cursor = field.position(from: field.beginningOfDocument, offset: min(prefix.utf16.count, next.utf16.count)) {
                field.selectedTextRange = field.textRange(from: cursor, to: cursor)
            }
            parent.code = next
            (field as? CodeTextField)?.refreshCells()
            return false
        }
        func textFieldDidBeginEditing(_ field: UITextField) { parent.isFocused = true; (field as? CodeTextField)?.refreshCells() }
        func textFieldDidEndEditing(_ field: UITextField) { parent.isFocused = false; (field as? CodeTextField)?.refreshCells() }
        func textFieldDidChangeSelection(_ field: UITextField) { (field as? CodeTextField)?.refreshCells() }
        func textFieldShouldReturn(_ field: UITextField) -> Bool { field.resignFirstResponder(); return true }
    }
}

final class CodeTextField: UITextField {
    private let cells = (0..<4).map { _ in UILabel() }
    private let stack = UIStackView()
    private let accent = UIColor(red: 0.35, green: 0.86, blue: 0.91, alpha: 1)
    override init(frame: CGRect) {
        super.init(frame: frame)
        borderStyle = .none; textColor = .clear; tintColor = .clear
        font = .monospacedSystemFont(ofSize: 28, weight: .medium)
        keyboardType = .asciiCapable; textContentType = .oneTimeCode
        autocapitalizationType = .allCharacters; autocorrectionType = .no; spellCheckingType = .no
        smartInsertDeleteType = .no; returnKeyType = .done
        stack.axis = .horizontal; stack.distribution = .fillEqually; stack.spacing = 10
        stack.isUserInteractionEnabled = false; stack.accessibilityElementsHidden = true
        for cell in cells {
            cell.font = font; cell.textAlignment = .center
            cell.layer.cornerRadius = 10; cell.layer.masksToBounds = true
            stack.addArrangedSubview(cell)
        }
        addSubview(stack)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: 58) }
    override func layoutSubviews() { super.layoutSubviews(); stack.frame = bounds; bringSubviewToFront(stack); refreshCells() }
    override func caretRect(for position: UITextPosition) -> CGRect { .zero }
    override func selectionRects(for range: UITextRange) -> [UITextSelectionRect] { [] }
    override func closestPosition(to point: CGPoint) -> UITextPosition? {
        let index = min(3, max(0, Int(point.x / max((bounds.width + 10) / 4, 1))))
        return position(from: beginningOfDocument, offset: min(index, (text ?? "").utf16.count))
    }
    func refreshCells() {
        let characters = Array(text ?? "")
        let invalid = characters.count > 4 || (text ?? "").utf8.contains { !(65...90).contains($0) && !(48...57).contains($0) }
        let cursor = selectedTextRange.map { offset(from: beginningOfDocument, to: $0.start) } ?? characters.count
        for (index, cell) in cells.enumerated() {
            let active = isFirstResponder && index == min(cursor, 3)
            cell.text = index < characters.count ? String(characters[index]) : ""
            cell.textColor = invalid ? .systemOrange : accent
            cell.backgroundColor = active ? accent.withAlphaComponent(0.09) : UIColor.black.withAlphaComponent(0.24)
            cell.layer.borderWidth = active ? 2 : 1
            cell.layer.borderColor = (invalid ? UIColor.systemOrange : active ? accent : UIColor.white.withAlphaComponent(0.18)).cgColor
        }
    }
}
