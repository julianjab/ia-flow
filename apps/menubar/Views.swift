import SwiftUI

// El marco del popover (y de la ventana): arriba el runner con su estado, la lupa y la ventana; debajo el segmentado
// Para mí · En curso · Próximo; al pie la caja del asistente, que abre el chat como panel encima. Las pantallas que
// se abren desde ahí (detalle, épica, Runners…) llevan su ruta de vuelta. También la pantalla «Runners» (con los
// servicios de este Mac) y las confirmaciones. Sólo dibujan lo que publican AppModel y RunnerModel.

let popoverWidth: CGFloat = 420

struct RootView: View {
    @ObservedObject var model: AppModel

    var body: some View { RootContent(model: model, runner: model.runner) }
}

struct RootContent: View {
    @ObservedObject var model: AppModel
    @ObservedObject var runner: RunnerModel
    @Environment(\.windowed) private var windowed

    var body: some View {
        ZStack(alignment: .bottom) {
            VStack(spacing: 0) {
                let home = runner.screen == .inbox
                if home || model.assistantOpen {
                    MainHeader(model: model, runner: runner)
                        .padding(.horizontal, 14).padding(.top, windowed ? 32 : 12).padding(.bottom, 8)  // en la ventana, debajo de los semáforos
                    ViewSegment(model: model, runner: runner).padding(.horizontal, 14).padding(.bottom, 10)
                }
                if model.assistantOpen {
                    AssistantScreen(chat: model.assistant, runner: runner) { model.assistantOpen = false }
                } else if home {
                    InboxScreen(runner: runner)
                    AssistantDock(model: model)
                } else if runner.screen == .runners {
                    RunnersScreen(model: model, runner: runner).padding(.top, windowed ? 22 : 0)
                } else {
                    RunnerScreen(runner: runner).padding(.top, windowed ? 22 : 0)
                }
            }
            if runner.comment != nil {
                CommentCard(runner: runner).padding(14).transition(.move(edge: .bottom).combined(with: .opacity))
            } else if let request = model.confirm {
                ConfirmCard(request: request, dismiss: { model.confirm = nil })
                    .padding(14)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if let text = model.toast {
                ToastView(text: text, undo: model.toastUndo.map { undo in { model.toast = nil; model.toastUndo = nil; undo() } })
                    .padding(.bottom, 62).transition(.opacity)
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

/// El runner elegido (nombre y «2 corriendo · 1 en cola · 1 de 3 lugares libres», abre «Runners»), la lupa (⌘K) y
/// la ventana (en la ventana, el pin).
struct MainHeader: View {
    @ObservedObject var model: AppModel
    @ObservedObject var runner: RunnerModel
    @Environment(\.windowed) private var windowed

    var body: some View {
        HStack(spacing: 6) {
            Button { model.assistantOpen = false; runner.showRunners() } label: {
                HStack(spacing: 9) {
                    RunnerDot(runner: runner)
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 4) {
                            Text(runner.selected.name).font(.lh(13.5, .semibold)).lineLimit(1)
                            Image(systemName: "chevron.down").font(.system(size: 8.5, weight: .bold)).foregroundStyle(.secondary)
                        }
                        Text(subtitle).font(.lh(11.5)).foregroundStyle(runner.error == nil ? Color.secondary : Palette.red).lineLimit(1)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Runners, estado, logs y servicios de este Mac")
            Spacer(minLength: 4)
            if runner.loading { ProgressView().controlSize(.small).scaleEffect(0.6) }
            IconButton(symbol: "magnifyingglass", help: "Buscar (⌘K)", tint: runner.searchOpen ? Palette.link : .secondary) {
                model.assistantOpen = false
                if runner.screen != .inbox { runner.goHome() }
                runner.toggleSearch()
            }
            .keyboardShortcut("k", modifiers: .command)
            if windowed {
                IconButton(symbol: model.floating ? "pin.fill" : "pin", help: model.floating ? "Dejar de mostrar siempre encima" : "Siempre encima de las otras ventanas",
                           tint: model.floating ? Palette.link : .secondary) { model.floating.toggle() }
            } else {
                IconButton(symbol: "macwindow", help: "Abrir en una ventana") { model.onDetach?() }
            }
        }
    }

    private var subtitle: String {
        if runner.error != nil { return runner.downFor.map { "no responde hace \($0)" } ?? "no responde" }
        return runner.pipelineLine ?? (runner.inbox == nil ? "conectando…" : "")
    }
}

/// El puntito del runner: verde si responde (con halo mientras el stream está conectado), rojo si no, ámbar cargando.
struct RunnerDot: View {
    @ObservedObject var runner: RunnerModel

    var body: some View {
        Circle().fill(runner.error == nil ? (runner.inbox == nil ? Palette.amber : Palette.live) : Palette.red).frame(width: 8, height: 8)
            // En vivo (stream conectado): un halo; sin él, la bandeja se relee cada 6 s.
            .overlay(Circle().strokeBorder(Palette.live.opacity(runner.live ? 0.45 : 0), lineWidth: 1.5).frame(width: 14, height: 14))
            .frame(width: 14, height: 14)
            .help(runner.live ? "En vivo: la bandeja se actualiza cuando algo cambia" : "La bandeja se relee cada 6 s")
    }
}

/// Para mí · En curso · Próximo: Para mí con su número en rojo (es el badge del ícono).
struct ViewSegment: View {
    @ObservedObject var model: AppModel
    @ObservedObject var runner: RunnerModel

    var body: some View {
        Segmented(options: InboxTab.allCases.map { tab in
            SegmentOption(id: tab.rawValue, title: tab.title, count: runner.inbox == nil ? nil : runner.count(tab), alert: tab == .mine)
        }, selected: model.assistantOpen || runner.searchOpen ? "" : runner.tab.rawValue) { id in
            if runner.searchOpen { runner.toggleSearch() }
            model.show(InboxTab(rawValue: id) ?? .mine)
        }
    }
}

/// La caja fija al pie: abre el chat del asistente encima de la vista; el micrófono abre y dicta.
struct AssistantDock: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            Divider().opacity(0.5)
            HStack(spacing: 8) {
                Button { model.openAssistant() } label: {
                    HStack(spacing: 7) {
                        Text("✦").font(.lh(13, .semibold)).foregroundStyle(Palette.ai)
                        Text("Pregúntale o pídele algo al asistente…").font(.lh(12.5)).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 11).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.control))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Abrir el asistente del runner")
                IconButton(symbol: "mic", help: "Dictarle al asistente") { model.openAssistant(listening: true) }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
        }
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
                    .buttonStyle(PillButtonStyle(prominent: true, tint: request.destructive ? Palette.red : Palette.blue))
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.regularMaterial))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.primary.opacity(0.15)))
        .shadow(color: .black.opacity(0.25), radius: 14, y: 4)
    }
}

/// El aviso de abajo; con `undo`, «Deshacer» al lado («Pospuesta hasta que cambie algo · Deshacer»).
struct ToastView: View {
    let text: String
    var undo: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 8) {
            Text(text).font(.lh(12, .semibold))
            if let undo {
                Text("·").opacity(0.5)
                Button("Deshacer", action: undo).buttonStyle(.plain).font(.lh(12, .bold)).foregroundStyle(Palette.link)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(Capsule().fill(Color.primary.opacity(0.88)))
        .foregroundStyle(Color(nsColor: .windowBackgroundColor))
    }
}

// MARK: Runners (reemplaza la pestaña «Servicios»)

/// Los runners para elegir, su estado y sus logs, los servicios de este Mac y la cuenta de GitHub.
struct RunnersScreen: View {
    @ObservedObject var model: AppModel
    @ObservedObject var runner: RunnerModel

    var body: some View {
        VStack(spacing: 0) {
            RouteHeader(back: runner.backLabel, title: "Runners") { runner.goBack() }
                .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 10)
            FittingScroll {
                VStack(alignment: .leading, spacing: 14) {
                    servers
                    HStack(spacing: 6) {
                        Button { runner.showHealth() } label: { Label("Estado del runner", systemImage: "heart.text.square") }
                            .buttonStyle(PillButtonStyle(compact: true)).fixedSize()
                        Button { runner.showLogs() } label: { Label("Logs del server", systemImage: "text.alignleft") }
                            .buttonStyle(PillButtonStyle(compact: true)).fixedSize()
                        Spacer(minLength: 0)
                    }
                    services
                    account
                }
                .padding(.horizontal, 14).padding(.bottom, 12)
            }
            Divider().opacity(0.5)
            HStack {
                Button("Editar servidores…") { runner.openServersFile() }.buttonStyle(.plain).font(.lh(12)).foregroundStyle(Palette.link)
                Spacer()
                IconButton(symbol: "arrow.clockwise", help: "Actualizar") { model.refresh(); runner.refresh(); runner.checkHealth() }
                IconButton(symbol: "power", help: "Salir de ia-flow (detiene los procesos que levantó)") { model.quit() }
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
        }
    }

    private var servers: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: "Elegí cuál mirar")
            VStack(spacing: 0) {
                ForEach(Array(runner.servers.enumerated()), id: \.element.baseUrl) { i, server in
                    if i > 0 { Divider().opacity(0.4).padding(.vertical, 6) }
                    serverRow(server)
                }
            }
            .card()
        }
    }

    private func serverRow(_ server: RunnerServer) -> some View {
        let on = server == runner.selected
        return Button { runner.select(server) } label: {
            HStack(spacing: 9) {
                if on { RunnerDot(runner: runner) } else { Circle().fill(Color.secondary.opacity(0.4)).frame(width: 8, height: 8).frame(width: 14) }
                VStack(alignment: .leading, spacing: 1) {
                    Text(server.name).font(.lh(13, .semibold)).lineLimit(1)
                    Text(on ? selectedStatus : server.baseUrl).font(.lh(11.5)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                if on { Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Palette.link) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var selectedStatus: String {
        if let error = runner.error { return error.needsRunnerToken ? "pide su token (IA_FLOW_API_TOKEN)" : "no responde" }
        guard let health = runner.health, health.alive else { return runner.inbox == nil ? "conectando…" : "responde" }
        return ["responde" + (health.latencyMs.map { " en \($0) ms" } ?? ""), health.info.map { "v\($0.version)" }]
            .compactMap { $0 }.joined(separator: " · ")
    }

    private var services: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: "Servicios en este Mac", trailing: "\(model.activeCount) de \(model.services.count) activos")
            VStack(spacing: 0) {
                ForEach(Array(model.services.enumerated()), id: \.element.spec.id) { i, service in
                    if i > 0 { Divider().opacity(0.4).padding(.vertical, 8) }
                    ServiceRow(model: model, service: service)
                }
            }
            .card()
            HStack(spacing: 6) {
                Button { model.restartAll() } label: { Label("Reiniciar todo", systemImage: "arrow.triangle.2.circlepath") }
                    .buttonStyle(PillButtonStyle(compact: true)).fixedSize()
                Button("Editar servicios…") { model.editConfig() }.buttonStyle(PillButtonStyle(compact: true)).fixedSize()
                Spacer()
                IconButton(symbol: "play.fill", help: "Iniciar todo") { model.startAll() }
                IconButton(symbol: "stop.fill", help: "Detener todo") { model.stopAll() }
            }
            Text("Los túneles de julianjab.link pasan a MacPulse.").font(.lh(11.5)).foregroundStyle(.tertiary)
        }
    }

    private var account: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: "Tu cuenta")
            if let login = runner.login {
                DeviceLoginCard(runner: runner, login: login)
            } else {
                HStack(spacing: 8) {
                    Image(systemName: "person.crop.circle").font(.system(size: 18)).foregroundStyle(.secondary)
                    if let session = runner.github {
                        (Text("Conectado como ") + Text("@\(session.login)").bold()).font(.lh(12.5))
                        Spacer()
                        Button("Salir") { runner.logout() }.buttonStyle(PillButtonStyle(compact: true)).fixedSize()
                    } else {
                        Text("Sin sesión de GitHub: las acciones se firman con tu login.").font(.lh(12)).foregroundStyle(.secondary)
                        Spacer(minLength: 4)
                        Button("Iniciar sesión") { runner.beginLogin() }.buttonStyle(PillButtonStyle(prominent: true, compact: true)).fixedSize()
                    }
                }
                .card()
            }
        }
    }
}

struct ServiceRow: View {
    @ObservedObject var model: AppModel
    let service: Service

    var body: some View {
        let state = service.state
        let external = service.isExternal
        HStack(spacing: 10) {
            PillSwitch(isOn: state == .running || state == .starting, enabled: !external && (state == .running || state == .stopped),
                       tint: state == .starting ? Palette.amber : Palette.live) { model.toggle(service) }
            VStack(alignment: .leading, spacing: 1) {
                Text(service.spec.name).font(.lh(13, .semibold)).lineLimit(1)
                Text(status(state, external)).font(.lh(11)).foregroundStyle(statusTone(state, external).color).lineLimit(1)
            }
            Spacer(minLength: 6)
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
        case .stopped: return external ? "puerto en uso por otro proceso" : "detenido"
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
