import SwiftUI

// Pantallas del popover: la lista de servicios agrupada en tarjetas y las confirmaciones. Sólo dibujan lo que AppModel publica; las acciones van al modelo.

let popoverWidth: CGFloat = 420

struct RootView: View {
    @ObservedObject var model: AppModel
    @Environment(\.windowed) private var windowed

    var body: some View {
        ZStack(alignment: .bottom) {
            VStack(spacing: 0) {
                do {
                    HStack(spacing: 6) {
                        TabBar(model: model, runner: model.runner)
                        if windowed {
                            IconButton(symbol: model.floating ? "pin.fill" : "pin", help: model.floating ? "Dejar de mostrar siempre encima" : "Siempre encima de las otras ventanas",
                                       tint: model.floating ? .accentColor : .secondary) { model.floating.toggle() }
                        } else {
                            IconButton(symbol: "macwindow.badge.plus", help: "Abrir en una ventana") { model.onDetach?() }
                        }
                    }
                    .padding(.horizontal, 14).padding(.top, windowed ? 32 : 12)  // en la ventana, debajo de los semáforos
                }
                if model.tab == .runner { RunnerScreen(runner: model.runner) }
                else if model.tab == .assistant { AssistantScreen(chat: model.assistant, runner: model.runner) }
                else { ListScreen(model: model) }
            }
            if model.runner.comment != nil {
                CommentCard(runner: model.runner).padding(14).transition(.move(edge: .bottom).combined(with: .opacity))
            } else if let request = model.confirm {
                ConfirmCard(request: request, dismiss: { model.confirm = nil })
                    .padding(14)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if let text = model.toast {
                ToastView(text: text).padding(.bottom, 62).transition(.opacity)
            }
        }
        .frame(minWidth: popoverWidth, idealWidth: popoverWidth, maxWidth: windowed ? .infinity : popoverWidth,
               maxHeight: windowed ? .infinity : nil, alignment: .top)
        // sigue traslúcido, pero con base: sin ella, lo que hay detrás compite con el texto
        .background(Color(nsColor: .windowBackgroundColor).opacity(0.6))
        .animation(.easeOut(duration: 0.15), value: model.confirm == nil)
        .font(.lh(13))
    }
}

struct ConfirmCard: View {
    let request: ConfirmRequest
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(request.title).font(.lh(14, .bold))
            Text(request.detail).font(.lh(12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancelar", action: dismiss).buttonStyle(PillButtonStyle(tint: .secondary)).keyboardShortcut(.cancelAction)
                Button(request.confirmLabel) { dismiss(); request.action() }
                    .buttonStyle(PillButtonStyle(prominent: true, tint: request.destructive ? .red : .accentColor))
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.regularMaterial))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.primary.opacity(0.15)))
        .shadow(color: .black.opacity(0.25), radius: 14, y: 4)
    }
}

struct ToastView: View {
    let text: String

    var body: some View {
        Text(text).font(.lh(12, .semibold)).padding(.horizontal, 12).padding(.vertical, 7)
            .background(Capsule().fill(Color.primary.opacity(0.85)))
            .foregroundStyle(Color(nsColor: .windowBackgroundColor))
    }
}

/// Runner | Asistente | Servicios, con el número de tareas que te esperan en el server elegido.
struct TabBar: View {
    @ObservedObject var model: AppModel
    @ObservedObject var runner: RunnerModel

    var body: some View {
        HStack(spacing: 4) {
            tab("Runner", icon: "list.bullet.rectangle", .runner, badge: runner.pendingCount)
            tab("Asistente", icon: "bubble.left.and.text.bubble.right", .assistant, badge: nil)
            tab("Servicios", icon: "switch.2", .services, badge: nil)
        }
        .padding(3)
        .background(Capsule().fill(Color.primary.opacity(0.06)))
    }

    private func tab(_ title: String, icon: String, _ value: AppModel.Tab, badge: Int?) -> some View {
        let on = model.tab == value
        return Button { model.selectTab(value) } label: {
            HStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 10.5, weight: .semibold))
                Text(title).font(.lh(12.5, .semibold))
                if let badge, badge > 0 {
                    Text("\(badge)").font(.lh(10.5, .bold)).foregroundStyle(.white)
                        .padding(.horizontal, 5).padding(.vertical, 1).background(Capsule().fill(Color.red))
                }
            }
            .frame(maxWidth: .infinity).padding(.vertical, 5)
            .foregroundStyle(on ? Color.primary : Color.secondary)
            .background(Capsule().fill(on ? Color(nsColor: .controlBackgroundColor) : Color.clear).shadow(color: .black.opacity(on ? 0.12 : 0), radius: 1, y: 0.5))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

// MARK: lista

struct ListScreen: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            header.padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 10)
            FittingScroll {
                VStack(spacing: 14) {
                    ForEach(model.groups) { group in GroupCard(model: model, group: group) }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 12)
            }
            Divider().opacity(0.5)
            footer.padding(.horizontal, 14).padding(.vertical, 10)
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(nsImage: appIcon(size: 30, running: model.activeCount > 0))
            VStack(alignment: .leading, spacing: 1) {
                Text("ia-flow").font(.lh(17, .bold))
                Text(subtitle).font(.lh(12)).foregroundStyle(.secondary)
            }
            Spacer()
            IconButton(symbol: "arrow.clockwise", help: "Actualizar") { model.refresh() }
        }
    }

    private var subtitle: String {
        let active = model.activeCount, total = model.services.count
        return active == 0 ? "Nada corriendo · \(total) servicios" : "\(active) de \(total) activos"
    }

    private var footer: some View {
        HStack(spacing: 4) {
            Text("Los túneles de julianjab.link pasan a MacPulse.").font(.lh(11)).foregroundStyle(.tertiary)
            Spacer()
            IconButton(symbol: "play.fill", help: "Iniciar todo") { model.startAll() }
            IconButton(symbol: "arrow.triangle.2.circlepath", help: "Reiniciar todo") { model.restartAll() }
            IconButton(symbol: "stop.fill", help: "Detener todo") { model.stopAll() }
            IconButton(symbol: "slider.horizontal.3", help: "Editar servicios.json") { model.editConfig() }
            IconButton(symbol: "power", help: "Salir (detiene los procesos que levantó)") { model.quit() }
        }
    }
}

struct GroupCard: View {
    @ObservedObject var model: AppModel
    let group: ServiceGroup

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: group.title, trailing: group.services.isEmpty ? nil : "\(running)/\(group.services.count)")
            VStack(spacing: 0) {
                ForEach(Array(group.services.enumerated()), id: \.element.spec.id) { index, service in
                    if index > 0 { Divider().opacity(0.4).padding(.vertical, 8) }
                    ServiceRow(model: model, service: service)
                }
            }
            .card()
        }
    }

    private var running: Int { group.services.filter { $0.state == .running }.count }
}

struct ServiceRow: View {
    @ObservedObject var model: AppModel
    let service: Service

    var body: some View {
        let state = service.state
        let external = service.isExternal
        HStack(spacing: 10) {
            PillSwitch(isOn: state == .running || state == .starting, enabled: !external && (state == .running || state == .stopped),
                       tint: state == .starting ? .orange : .green) { model.toggle(service) }
            VStack(alignment: .leading, spacing: 1) {
                Text(service.spec.name).font(.lh(14, .semibold)).lineLimit(1)
                Text(status(state, external)).font(.lh(11)).foregroundStyle(statusTone(state, external).color).lineLimit(1)
            }
            Spacer(minLength: 6)
            if external { Chip(text: "externo", tone: .warn, icon: "exclamationmark.triangle.fill") }
            if let port = service.spec.port { portChip(port) }
            actionsMenu(state)
        }
    }

    @ViewBuilder
    private func portChip(_ port: Int) -> some View {
        if service.spec.url != nil {
            Button { model.openURL(service) } label: { Chip(text: ":\(port)", tone: .info, icon: "arrow.up.right") }
                .buttonStyle(.plain).help("Abrir \(service.spec.url ?? "")")
        } else {
            Chip(text: ":\(port)")
        }
    }

    private func actionsMenu(_ state: Service.State) -> some View {
        Menu {
            Button("Reiniciar") { model.restart(service) }.disabled(state != .running)
            if service.spec.url != nil { Button("Abrir en el navegador") { model.openURL(service) } }
            Button("Ver log en iTerm") { model.openLog(service) }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 12, weight: .semibold)).frame(width: 26, height: 26).contentShape(Circle())
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().foregroundStyle(.secondary)
    }

    private func status(_ state: Service.State, _ external: Bool) -> String {
        switch state {
        case .running: return service.spec.url?.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "") ?? "corriendo"
        case .starting: return "iniciando…"
        case .stopping: return "deteniendo…"
        case .stopped: return external ? "puerto en uso" : "detenido"
        }
    }

    private func statusTone(_ state: Service.State, _ external: Bool) -> Tone {
        switch state {
        case .running: return .ok
        case .starting, .stopping: return .warn
        case .stopped: return external ? .warn : .neutral
        }
    }
}
