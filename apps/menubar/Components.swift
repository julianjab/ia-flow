import SwiftUI

// Componentes visuales del popover: chips, switch, botones en cápsula, tarjetas y un layout que envuelve líneas.
// Todo se dibuja en SwiftUI (sin NSView) para que se vea igual en claro y oscuro y se pueda renderizar a PNG
// con --screenshot. Sin lógica de servicios: reciben texto, tono y acciones.

enum Tone {
    case ok, warn, bad, info, neutral

    var color: Color {
        switch self {
        case .ok: return .green
        case .warn: return .orange
        case .bad: return .red
        case .info: return .blue
        case .neutral: return .secondary
        }
    }
}

extension Font {
    static func lh(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .rounded)
    }
}

// MARK: chip

struct Chip: View {
    let text: String
    var tone: Tone = .neutral
    var icon: String? = nil

    var body: some View {
        HStack(spacing: 4) {
            if let icon { Image(systemName: icon).font(.system(size: 8.5, weight: .bold)) }
            Text(text).font(.lh(11, .semibold)).lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .foregroundStyle(tone == .neutral ? Color.secondary : tone.color)
        .background(Capsule().fill(tone == .neutral ? Color.primary.opacity(0.07) : tone.color.opacity(0.15)))
    }
}

/// La etiqueta de un repo: siempre del mismo color para el mismo repo, para distinguirlos de un vistazo.
struct RepoTag: View {
    let repo: String
    var number: Int? = nil
    var chevron = false

    private static let palette: [Color] = [.blue, .purple, .pink, .indigo, .orange, .green, .brown]

    /// Un hash estable (no `hashValue`, que cambia entre ejecuciones).
    static func color(_ repo: String) -> Color {
        palette[repo.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF } % palette.count]
    }

    var body: some View {
        let color = RepoTag.color(repo)
        HStack(spacing: 3) {
            Text(repo).font(.lh(10.5, .semibold)).lineLimit(1)
            if let number { Text("#" + String(number)).font(.lh(10.5, .bold)).opacity(0.75) }
            if chevron { Image(systemName: "chevron.down").font(.system(size: 7.5, weight: .bold)).opacity(0.7) }
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 2.5)
        .foregroundStyle(color)
        .background(Capsule().fill(color.opacity(0.14)))
        .fixedSize()
    }
}

/// Chip seleccionable (los puertos en escucha del formulario de túnel).
struct SelectChip: View {
    let label: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label).font(.lh(12, .semibold)).lineLimit(1)
                .padding(.horizontal, 11)
                .padding(.vertical, 5)
                .foregroundStyle(selected ? Color.white : Color.primary.opacity(0.8))
                .background(Capsule().fill(selected ? Color.accentColor : Color.primary.opacity(0.07)))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

// MARK: botones

struct PillButtonStyle: ButtonStyle {
    var prominent = false
    var tint: Color = .accentColor
    var enabled = true
    /// Más chico y en una sola línea: los botones dentro de una fila (las acciones de una tarea).
    var compact = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.lh(compact ? 11.5 : 12.5, .semibold))
            .lineLimit(1)
            .padding(.horizontal, compact ? 10 : 14)
            .padding(.vertical, compact ? 4 : 7)
            .foregroundStyle(prominent ? Color.white : tint)
            .background(Capsule().fill(prominent ? tint : tint.opacity(0.12)))
            .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.4)
            .contentShape(Capsule())
    }
}

struct IconButton: View {
    let symbol: String
    let help: String
    var tint: Color = .secondary
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .semibold))
                .frame(width: 26, height: 26)
                .background(Circle().fill(Color.primary.opacity(hover ? 0.1 : 0)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(tint)
        .help(help)
        .onHover { hover = $0 }
    }
}

/// Switch dibujado a mano (34×20): igual en claro y oscuro y en las capturas.
struct PillSwitch: View {
    let isOn: Bool
    var enabled = true
    var tint: Color = .green
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack(alignment: isOn ? .trailing : .leading) {
                Capsule().fill(isOn ? tint : Color.primary.opacity(0.18)).frame(width: 34, height: 20)
                Circle().fill(Color.white).shadow(color: .black.opacity(0.25), radius: 1, y: 0.5)
                    .frame(width: 16, height: 16).padding(2)
            }
            .animation(.easeOut(duration: 0.12), value: isOn)
        }
        .buttonStyle(.plain)
        .opacity(enabled ? 1 : 0.4)
        .disabled(!enabled)
        .accessibilityLabel(isOn ? "Detener" : "Iniciar")
    }
}

// MARK: contenedores

struct CardStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.primary.opacity(0.045)))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.primary.opacity(0.07), lineWidth: 1))
    }
}

extension View {
    func card() -> some View { modifier(CardStyle()) }
}

struct SectionTitle: View {
    let text: String
    var trailing: String? = nil

    var body: some View {
        HStack {
            Text(text.uppercased()).font(.lh(10.5, .bold)).foregroundStyle(.secondary).tracking(0.6)
            Spacer()
            if let trailing { Text(trailing).font(.lh(11)).foregroundStyle(.tertiary) }
        }
    }
}

struct FieldBox<Content: View>: View {
    var invalid = false
    @ViewBuilder let content: Content

    var body: some View {
        content
            .textFieldStyle(.plain)
            .font(.lh(13))
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.primary.opacity(0.06)))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(invalid ? Color.red.opacity(0.7) : Color.clear, lineWidth: 1.5))
    }
}

/// Aviso con texto, tono y, opcionalmente, botones de acción (confirmaciones dentro del formulario).
struct Banner<Actions: View>: View {
    let text: String
    var tone: Tone = .warn
    var icon = "exclamationmark.triangle.fill"
    @ViewBuilder let actions: Actions

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: icon).foregroundStyle(tone.color).font(.system(size: 12, weight: .bold)).padding(.top, 1)
                Text(text).font(.lh(12)).foregroundStyle(.primary.opacity(0.85))
                    .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
            }
            actions
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(tone.color.opacity(0.12)))
    }
}

extension Banner where Actions == EmptyView {
    init(text: String, tone: Tone = .warn, icon: String = "exclamationmark.triangle.fill") {
        self.init(text: text, tone: tone, icon: icon) { EmptyView() }
    }
}

// MARK: layout que envuelve

struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(proposal.width ?? popoverWidth, subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (i, p) in arrange(bounds.width, subviews).origins.enumerated() {
            subviews[i].place(at: CGPoint(x: bounds.minX + p.x, y: bounds.minY + p.y), proposal: .unspecified)
        }
    }

    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> (size: CGSize, origins: [CGPoint]) {
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0, maxW: CGFloat = 0
        var origins: [CGPoint] = []
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x > 0, x + sz.width > width { x = 0; y += rowH + spacing; rowH = 0 }
            origins.append(CGPoint(x: x, y: y))
            x += sz.width + spacing
            rowH = max(rowH, sz.height)
            maxW = max(maxW, x - spacing)
        }
        return (CGSize(width: maxW, height: y + rowH), origins)
    }
}

struct HeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// Tope del scroll del popover; las capturas (`--screenshot`) lo suben para ver todo el contenido.
var popoverMaxScroll: CGFloat = 520

/// En una ventana (no en el popover): las listas ocupan el alto que haya en vez de un tope fijo.
private struct WindowedKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
    var windowed: Bool {
        get { self[WindowedKey.self] }
        set { self[WindowedKey.self] = newValue }
    }
}

/// Un scroll de alto fijo en el popover; en la ventana, todo el alto disponible.
private struct ScrollHeight: ViewModifier {
    @Environment(\.windowed) private var windowed
    let fixed: CGFloat

    func body(content: Content) -> some View {
        if windowed { content.frame(minHeight: 120, maxHeight: .infinity) } else { content.frame(height: fixed) }
    }
}

extension View {
    func scrollHeight(_ fixed: CGFloat) -> some View { modifier(ScrollHeight(fixed: fixed)) }
}

/// ScrollView que se ajusta a su contenido hasta `popoverMaxScroll` (el popover no debe quedar con huecos); en la
/// ventana ocupa el alto que haya.
struct FittingScroll<Content: View>: View {
    @ViewBuilder let content: Content
    @State private var height: CGFloat = 160
    @Environment(\.windowed) private var windowed

    var body: some View {
        ScrollView(showsIndicators: false) {
            content.background(GeometryReader { g in Color.clear.preference(key: HeightKey.self, value: g.size.height) })
        }
        .onPreferenceChange(HeightKey.self) { height = $0 }
        .frame(minHeight: windowed ? 60 : min(max(height, 60), popoverMaxScroll),
               maxHeight: windowed ? .infinity : min(max(height, 60), popoverMaxScroll), alignment: .top)
    }
}
