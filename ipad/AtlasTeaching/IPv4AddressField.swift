import SwiftUI
import UIKit

struct IPv4AddressField: UIViewRepresentable {
    @Binding var host: String
    @Binding var error: String
    var onSubmit: () -> Void

    func makeUIView(context: Context) -> IPv4InputView { IPv4InputView() }
    func updateUIView(_ view: IPv4InputView, context: Context) {
        view.onChange = { host = $0; error = "" }
        view.onReject = { error = $0 }
        view.onSubmit = onSubmit
        view.setHost(host)
        view.setEnabled(context.environment.isEnabled)
    }
}

// Native fields apply an entire edit before publishing it to SwiftUI, keeping
// rapid typing, selection, paste and focus changes in the same transaction.
final class IPv4InputView: UIView, UITextFieldDelegate {
    var onChange: (String) -> Void = { _ in }
    var onReject: (String) -> Void = { _ in }
    var onSubmit: () -> Void = {}
    private let fields = (0..<4).map { _ in IPv4OctetField() }
    private let dots = (0..<3).map { _ in UILabel() }
    private var appliedHost = ""
    private var skipSeparator = false
    private let accent = UIColor(red: 0.35, green: 0.86, blue: 0.91, alpha: 1)

    override init(frame: CGRect) {
        super.init(frame: frame)
        accessibilityIdentifier = "server-address"
        let toolbar = UIToolbar(); toolbar.sizeToFit()
        toolbar.items = [
            UIBarButtonItem(title: "上一段", style: .plain, target: self, action: #selector(previous)),
            UIBarButtonItem(title: "下一段", style: .plain, target: self, action: #selector(nextOctet)),
            UIBarButtonItem(systemItem: .flexibleSpace),
            UIBarButtonItem(title: "完成", style: .done, target: self, action: #selector(done)),
        ]
        for (index, field) in fields.enumerated() {
            field.tag = index; field.delegate = self
            field.font = .monospacedSystemFont(ofSize: 17, weight: .regular)
            field.textAlignment = .center; field.tintColor = accent
            field.backgroundColor = UIColor.black.withAlphaComponent(0.24)
            field.layer.cornerRadius = 8; field.layer.borderWidth = 1
            field.keyboardType = .numberPad; field.returnKeyType = .next
            field.autocorrectionType = .no; field.spellCheckingType = .no; field.smartInsertDeleteType = .no
            field.placeholder = ["192", "168", "1", "20"][index]
            field.inputAccessoryView = toolbar
            field.accessibilityIdentifier = "server-address-octet-\(index)"
            field.accessibilityLabel = "IPv4 地址第 \(index + 1) 段"
            field.accessibilityHint = "输入 0 到 255，也可粘贴完整 IPv4 地址"
            field.onEmptyBackspace = { [weak self] in self?.deleteFromPrevious(index) }
            addSubview(field)
        }
        for dot in dots { dot.text = "."; dot.textAlignment = .center; dot.textColor = .secondaryLabel; dot.isAccessibilityElement = false; addSubview(dot) }
        refreshBorders()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: 44) }
    override func layoutSubviews() {
        super.layoutSubviews()
        let gap: CGFloat = 12, width = max(0, (bounds.width - gap * 3) / 4)
        for (index, field) in fields.enumerated() {
            field.frame = CGRect(x: CGFloat(index) * (width + gap), y: 0, width: width, height: bounds.height)
            if index < 3 { dots[index].frame = CGRect(x: field.frame.maxX, y: 0, width: gap, height: bounds.height) }
        }
    }
    func setHost(_ host: String) {
        guard host != appliedHost else { return }
        appliedHost = host; skipSeparator = false
        let parts = IPv4Input.octets(host, allowingEmpty: true) ?? Array(repeating: "", count: 4)
        for (field, part) in zip(fields, parts) { field.text = part }
    }
    func setEnabled(_ enabled: Bool) { fields.forEach { $0.isEnabled = enabled }; alpha = enabled ? 1 : 0.5 }
    private func publish() {
        let parts = fields.map { $0.text ?? "" }
        appliedHost = parts.allSatisfy(\.isEmpty) ? "" : parts.joined(separator: ".")
        onChange(appliedHost)
    }
    private func focus(_ index: Int) {
        skipSeparator = false
        if index < 4 { fields[max(0, index)].becomeFirstResponder(); fields[max(0, index)].selectAll(nil) }
        else { endEditing(true); onSubmit() }
    }
    private var active: Int? { fields.firstIndex { $0.isFirstResponder } }
    @objc private func previous() { if let active { focus(max(0, active - 1)) } }
    @objc private func nextOctet() { if let active, !(fields[active].text ?? "").isEmpty { focus(active + 1) } }
    @objc private func done() { endEditing(true) }
    private func deleteFromPrevious(_ index: Int) {
        guard index > 0 else { return }
        let previous = fields[index - 1]
        focus(index - 1)
        previous.text = String((previous.text ?? "").dropLast())
        previous.selectedTextRange = previous.textRange(from: previous.endOfDocument, to: previous.endOfDocument)
        publish()
    }
    private func refreshBorders() {
        for field in fields {
            field.layer.borderColor = (field.isFirstResponder ? accent : UIColor.white.withAlphaComponent(0.18)).cgColor
            field.layer.borderWidth = field.isFirstResponder ? 2 : 1
        }
    }
    func textFieldDidBeginEditing(_ field: UITextField) { skipSeparator = false; field.selectAll(nil); refreshBorders() }
    func textFieldDidEndEditing(_ field: UITextField) {
        if let text = field.text, let number = Int(text) { field.text = String(number); publish() }
        refreshBorders()
    }
    func textFieldShouldReturn(_ field: UITextField) -> Bool { nextOctet(); return false }
    func textField(_ field: UITextField, shouldChangeCharactersIn range: NSRange, replacementString replacement: String) -> Bool {
        let index = field.tag
        if replacement == "." {
            if skipSeparator { skipSeparator = false }
            else if !(field.text ?? "").isEmpty { focus(index + 1) }
            return false
        }
        skipSeparator = false
        if replacement.contains(".") {
            let text = replacement.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let parts = IPv4Input.octets(text) else { onReject("请输入完整 IPv4 地址，每段为 0～255"); return false }
            for (field, part) in zip(fields, parts) { field.text = String(Int(part)!) }
            publish(); focus(3)
            return false
        }
        let current = field.text ?? ""
        guard let editRange = Range(range, in: current) else { return false }
        let value = current.replacingCharacters(in: editRange, with: replacement)
        guard IPv4Input.acceptsOctet(value) else { onReject("每段仅可输入 0～255"); return false }
        field.text = value
        let offset = current[..<editRange.lowerBound].utf16.count + replacement.utf16.count
        if let cursor = field.position(from: field.beginningOfDocument, offset: offset) { field.selectedTextRange = field.textRange(from: cursor, to: cursor) }
        publish()
        if !replacement.isEmpty && value.count == 3 && index < 3 { focus(index + 1); skipSeparator = true }
        return false
    }
}

final class IPv4OctetField: UITextField {
    var onEmptyBackspace: () -> Void = {}
    private var selectOnTouchUp = false
    override func deleteBackward() {
        if (text ?? "").isEmpty { onEmptyBackspace() } else { super.deleteBackward() }
    }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        selectOnTouchUp = !isFirstResponder; super.touchesBegan(touches, with: event)
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesEnded(touches, with: event)
        if selectOnTouchUp { selectAll(nil); selectOnTouchUp = false }
    }
}
