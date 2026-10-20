import AppKit
import SwiftUI

// Una fila con sus acciones escondidas: aparecen al deslizarla a la izquierda (dos dedos en el trackpad o
// arrastrando), como en mac-pulse y en las filas de «Después» de la web. Es un atajo: quien la usa deja las mismas
// acciones en su clic derecho y en el detalle, porque el gesto no se descubre.

/// Una acción detrás de una fila. Lo que confirma lo confirma quien la corre (`RunnerModel.trigger`).
struct SwipeAction: Identifiable {
    let id: String
    let icon: String
    let label: String
    var color: Color = .accentColor
    let run: () -> Void
}

/// Quién está abierta y a quién van los gestos del trackpad. Una sola fila abierta a la vez.
final class SwipeState: ObservableObject {
    static let shared = SwipeState()

    @Published var open: String?
    /// La fila bajo el mouse: recibe el deslizamiento horizontal de dos dedos.
    var hovered: String?
    var handlers: [String: (NSEvent) -> Void] = [:]
    /// Si el gesto en curso es horizontal (se decide al empezar y vale hasta que termina).
    private var horizontal: Bool?
    private var monitor: Any?

    /// Los gestos horizontales sobre una fila la deslizan; los verticales siguen siendo el scroll de la lista.
    func install() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] e in
            guard let self, e.hasPreciseScrollingDeltas else { return e }
            if e.phase == .began || e.phase == .mayBegin { self.horizontal = nil }
            if e.momentumPhase != [] { return self.horizontal == true ? nil : e }
            if self.horizontal == nil, e.phase == .began || e.phase == .changed {
                guard e.scrollingDeltaX != 0 || e.scrollingDeltaY != 0 else { return e }
                self.horizontal = abs(e.scrollingDeltaX) > abs(e.scrollingDeltaY)
            }
            guard self.horizontal == true, let id = self.hovered, let handle = self.handlers[id] else { return e }
            handle(e)
            if e.phase == .ended || e.phase == .cancelled { self.horizontal = nil }
            return nil
        }
    }
}

/// La fila: se resalta bajo el mouse y, deslizada, muestra sus acciones. Abierta, un clic la cierra.
struct SwipeRow<Content: View>: View {
    let id: String
    let actions: [SwipeAction]
    @ViewBuilder let content: () -> Content

    @ObservedObject private var swipe = SwipeState.shared
    @State private var offset: CGFloat = 0
    @State private var dragStart: CGFloat?
    @State private var hovering = false

    private static var buttonWidth: CGFloat { 64 }
    private var width: CGFloat { CGFloat(actions.count) * Self.buttonWidth }

    var body: some View {
        ZStack(alignment: .trailing) {
            if offset < 0 { buttons }
            content()
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 5).padding(.horizontal, 6)
                .background(Color.primary.opacity(hovering && offset == 0 ? 0.05 : 0))
                .background(.background.opacity(offset < 0 ? 1 : 0))
                .contentShape(Rectangle())
                .overlay {
                    if offset < 0 { Color.clear.contentShape(Rectangle()).onTapGesture { close() } }
                }
                .offset(x: offset)
                .gesture(actions.isEmpty ? nil : drag)
        }
        .padding(.horizontal, -6)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .onHover { inside in
            hovering = inside
            if inside { swipe.hovered = id } else if swipe.hovered == id { swipe.hovered = nil }
        }
        .onAppear {
            guard !actions.isEmpty else { return }
            swipe.install()
            let offset = $offset
            let width = width
            swipe.handlers[id] = { [id] e in
                // con el desplazamiento natural, los dedos a la izquierda dan deltas negativos
                let dx = e.isDirectionInvertedFromDevice ? e.scrollingDeltaX : -e.scrollingDeltaX
                if e.phase == .ended || e.phase == .cancelled {
                    let open = offset.wrappedValue < -width / 2
                    withAnimation(.easeOut(duration: 0.18)) { offset.wrappedValue = open ? -width : 0 }
                    if open { SwipeState.shared.open = id } else if SwipeState.shared.open == id { SwipeState.shared.open = nil }
                } else {
                    offset.wrappedValue = min(0, max(-width - 20, offset.wrappedValue + dx))
                }
            }
        }
        .onDisappear { if swipe.handlers[id] != nil { swipe.handlers[id] = nil } }
        .onChange(of: swipe.open) { _, open in
            if open != id && offset != 0 { withAnimation(.easeOut(duration: 0.18)) { offset = 0 } }
        }
    }

    private var buttons: some View {
        HStack(spacing: 0) {
            ForEach(actions) { a in
                Button {
                    close()
                    a.run()
                } label: {
                    VStack(spacing: 2) {
                        Image(systemName: a.icon).font(.system(size: 13, weight: .semibold))
                        Text(a.label).font(.lh(9.5, .semibold)).lineLimit(1).minimumScaleFactor(0.8)
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 3)
                    .frame(width: Self.buttonWidth)
                    .frame(maxHeight: .infinity)
                    .background(a.color)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(a.label)
            }
        }
        // sólo lo que la fila ya destapó
        .frame(width: max(0, -offset), alignment: .trailing)
        .clipped()
    }

    /// Arrastrar con el mouse hace lo mismo que los dos dedos.
    private var drag: some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { v in
                guard abs(v.translation.width) > abs(v.translation.height) else { return }
                let start = dragStart ?? offset
                dragStart = start
                offset = min(0, max(-width - 20, start + v.translation.width))
            }
            .onEnded { _ in
                dragStart = nil
                let open = offset < -width / 2
                withAnimation(.easeOut(duration: 0.18)) { offset = open ? -width : 0 }
                if open { swipe.open = id } else if swipe.open == id { swipe.open = nil }
            }
    }

    private func close() {
        withAnimation(.easeOut(duration: 0.18)) { offset = 0 }
        if swipe.open == id { swipe.open = nil }
    }
}
