import SwiftUI

// La pestaña «Runner» del popover: lo que te espera en el server elegido, lo que corre, las épicas y qué sigue en
// cada una, y el log del proceso. Sólo dibuja lo que publica RunnerModel; las acciones van al modelo.

struct RunnerScreen: View {
    @ObservedObject var runner: RunnerModel

    var body: some View {
        switch runner.screen {
        case .inbox: RunnerInboxScreen(runner: runner)
        case .logs: RunnerLogsScreen(runner: runner)
        }
    }
}

// MARK: bandeja

struct RunnerInboxScreen: View {
    @ObservedObject var runner: RunnerModel

    var body: some View {
        VStack(spacing: 0) {
            header.padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 10)
            FittingScroll {
                VStack(alignment: .leading, spacing: 14) {
                    if let error = runner.error { errorBanner(error) }
                    if let login = runner.login { DeviceLoginCard(runner: runner, login: login) }
                    else if runner.github == nil, runner.error == nil, runner.inbox != nil { loginBanner }
                    if let pipeline = runner.inbox?.pipeline { capacity(pipeline) }
                    if runner.inbox != nil { sections }
                    else if runner.error == nil { loadingCard }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 12)
            }
            Divider().opacity(0.5)
            footer.padding(.horizontal, 14).padding(.vertical, 10)
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Menu {
                ForEach(runner.servers, id: \.baseUrl) { server in
                    Button { runner.select(server) } label: {
                        if server == runner.selected { Label(server.name, systemImage: "checkmark") } else { Text(server.name) }
                    }
                }
                Divider()
                Button("Editar servidores…") { runner.openServersFile() }
            } label: {
                HStack(spacing: 5) {
                    Circle().fill(runner.error == nil ? (runner.inbox == nil ? Color.orange : Color.green) : Color.red).frame(width: 7, height: 7)
                    Text(runner.selected.name).font(.lh(13, .semibold)).lineLimit(1)
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
                }
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            Spacer()
            if runner.loading { ProgressView().controlSize(.small).scaleEffect(0.6) }
            if let session = runner.github {
                Menu {
                    Button("Cerrar sesión de GitHub", role: .destructive) { runner.logout() }
                } label: { Chip(text: session.login, icon: "person.fill") }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            }
            IconButton(symbol: "arrow.clockwise", help: "Actualizar") { runner.refresh() }
        }
    }

    private func errorBanner(_ error: RunnerError) -> some View {
        Banner(text: error.needsRunnerToken
               ? "\(runner.selected.name) pide su IA_FLOW_API_TOKEN: agrégalo como «token» en la lista de servidores. (\(error.message))"
               : error.message, tone: .bad, icon: "xmark.octagon.fill") {
            if error.needsRunnerToken {
                Button("Editar servidores") { runner.openServersFile() }.buttonStyle(PillButtonStyle(prominent: true, tint: .red))
            }
        }
    }

    private var loginBanner: some View {
        Banner(text: "Para aprobar, reintentar o responder, el runner firma con tu login de GitHub.", tone: .info, icon: "person.badge.key.fill") {
            Button("Iniciar sesión con GitHub") { runner.beginLogin() }.buttonStyle(PillButtonStyle(prominent: true))
        }
    }

    private var loadingCard: some View {
        HStack { ProgressView().controlSize(.small); Text("Leyendo la bandeja…").foregroundStyle(.secondary) }
            .frame(maxWidth: .infinity, alignment: .leading).card()
    }

    private func capacity(_ p: InboxPipeline) -> some View {
        FlowLayout {
            Chip(text: "\(p.running) corriendo", tone: p.running > 0 ? .ok : .neutral, icon: "play.fill")
            if p.queued > 0 { Chip(text: "\(p.queued) en cola", tone: .warn, icon: "hourglass") }
            if p.paused > 0 { Chip(text: "\(p.paused) esperando CI", tone: .info, icon: "pause.fill") }
            if let free = p.free, let cap = p.capacity { Chip(text: "\(free)/\(cap) libres") }
        }
    }

    @ViewBuilder
    private var sections: some View {
        let decisions = runner.decisions, running = runner.running, epics = runner.epics, queued = runner.queued
        section("Te necesita", count: decisions.count, empty: "Nada esperando una decisión tuya.") {
            ForEach(Array(decisions.enumerated()), id: \.element.ref) { i, item in
                if i > 0 { Divider().opacity(0.4).padding(.vertical, 10) }
                TaskRow(runner: runner, item: item, primary: i == 0)
            }
        }
        if !runner.improvements.isEmpty {
            section("Mejoras propuestas", count: runner.improvements.count) {
                ForEach(Array(runner.improvements.enumerated()), id: \.element.id) { i, improvement in
                    if i > 0 { Divider().opacity(0.4).padding(.vertical, 10) }
                    ImprovementRow(runner: runner, improvement: improvement)
                }
            }
        }
        if !epics.isEmpty {
            section("Épicas", count: epics.count) {
                ForEach(Array(epics.enumerated()), id: \.element.id) { i, epic in
                    if i > 0 { Divider().opacity(0.4).padding(.vertical, 8) }
                    EpicRow(runner: runner, epic: epic)
                }
            }
        }
        section("Corriendo", count: running.count, empty: "Ningún agente trabajando ahora.") {
            ForEach(Array(running.enumerated()), id: \.element.ref) { i, item in
                if i > 0 { Divider().opacity(0.4).padding(.vertical, 10) }
                TaskRow(runner: runner, item: item)
            }
        }
        if !queued.isEmpty {
            section("En cola", count: queued.count) {
                ForEach(Array(queued.prefix(6).enumerated()), id: \.element.ref) { i, item in
                    if i > 0 { Divider().opacity(0.4).padding(.vertical, 6) }
                    CompactRow(runner: runner, item: item)
                }
            }
        }
    }

    /// Una sección que se colapsa con un clic en su título (lo recuerda entre aperturas del popover).
    private func section<Content: View>(_ title: String, count: Int, empty: String? = nil, @ViewBuilder content: () -> Content) -> some View {
        let collapsed = runner.isCollapsed(title)
        return VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.easeOut(duration: 0.15)) { runner.toggleSection(title) } } label: {
                HStack(spacing: 5) {
                    Image(systemName: "chevron.right").font(.system(size: 8.5, weight: .bold)).foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(collapsed ? 0 : 90))
                    SectionTitle(text: title, trailing: count > 0 ? "\(count)" : nil)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(collapsed ? "Mostrar" : "Ocultar")
            if !collapsed {
                VStack(alignment: .leading, spacing: 0) {
                    if count == 0, let empty { Text(empty).font(.lh(12)).foregroundStyle(.tertiary).frame(maxWidth: .infinity, alignment: .leading) }
                    content()
                }
                .card()
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 4) {
            Button { runner.screen = .logs } label: { Label("Logs del server", systemImage: "text.alignleft") }
                .buttonStyle(PillButtonStyle(prominent: true))
            Spacer()
            if runner.boardURL != nil { IconButton(symbol: "rectangle.split.3x1", help: "Abrir el board en GitHub") { runner.openBoard() } }
            IconButton(symbol: "server.rack", help: "Editar servidores") { runner.openServersFile() }
        }
    }
}

/// Una tarea: qué caso es y hace cuánto, el título, por qué está acá y sus acciones. Sólo la primera decisión de la
/// pantalla lleva el botón lleno (como en la web, un solo primario); las demás, en tono.
struct TaskRow: View {
    @ObservedObject var runner: RunnerModel
    let item: InboxItem
    var primary = false

    var body: some View {
        let actions = actionsOf(item)
        let busy = runner.busy.contains(item.ref)
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                kindChip
                Text(meta).font(.lh(11)).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 4)
                Button { runner.open(item) } label: { Text(item.shortRef).font(.lh(11.5, .semibold)).foregroundStyle(.tertiary) }
                    .buttonStyle(.plain).help("Abrir \(item.ref) en GitHub")
            }
            Button { runner.open(item) } label: {
                Text(item.displayTitle).font(.lh(13, .semibold)).lineLimit(2).multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain).help(item.title)
            if let said = item.agent_said, item.isDecision {
                Text("«\(said)»").font(.lh(11.5)).italic().foregroundStyle(.primary.opacity(0.7)).lineLimit(3)
            }
            HStack(spacing: 6) {
                if let first = actions.first {
                    Button { runner.trigger(first, on: item) } label: {
                        if busy { ProgressView().controlSize(.small).scaleEffect(0.5).frame(width: 40, height: 14) }
                        else { Text(first.confirms ? "\(first.label)…" : first.label) }
                    }
                    .buttonStyle(PillButtonStyle(prominent: primary, tint: first.id == "stop" ? .red : .accentColor, compact: true))
                    .fixedSize()
                    .disabled(busy)
                }
                if let pr = item.pr {
                    Button { runner.openPR(item) } label: { Chip(text: "PR #\(pr.number)", tone: .info, icon: "arrow.up.right") }
                        .buttonStyle(.plain).fixedSize()
                }
                if let epic = item.epic {
                    Chip(text: "\(epic.done)/\(epic.total) · \(epic.displayTitle)", icon: "square.stack.3d.up")
                        .help("Épica \(epic.ref): \(epic.title)")
                }
                Spacer(minLength: 0)
                Menu {
                    ForEach(actions.dropFirst()) { action in
                        Button(action.confirms ? "\(action.label)…" : action.label, role: action.id == "stop" ? .destructive : nil) {
                            runner.trigger(action, on: item)
                        }
                    }
                    if actions.count > 1 { Divider() }
                    Button("Abrir issue en GitHub") { runner.open(item) }
                    if item.pr != nil { Button("Abrir PR") { runner.openPR(item) } }
                    if let epic = item.epic { Button("Abrir épica") { runner.openEpic(epic) } }
                } label: {
                    Image(systemName: "ellipsis").font(.system(size: 12, weight: .semibold)).frame(width: 24, height: 20).contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().foregroundStyle(.secondary)
            }
            .padding(.top, 2)
        }
    }

    /// El porqué sin repetir el PR (va como chip) y con hace cuánto.
    private var meta: String {
        var why = item.why
        if let pr = item.pr { why = why.replacingOccurrences(of: " · PR #\(pr.number)", with: "") }
        return [why, item.age].compactMap { $0 }.joined(separator: " · ")
    }

    private var kindChip: some View {
        let (text, tone): (String, Tone) = {
            switch item.kind {
            case "merge": return ("merge", .ok)
            case "prd": return ("PRD", .info)
            case "doubt", "prerequisite": return ("bloqueada", .warn)
            case "crash": return ("falló", .bad)
            case "stale": return ("quieta", .warn)
            case "review": return ("review", .info)
            case "agent": return (item.execution?.agent_id?.replacingOccurrences(of: "aiflow-", with: "") ?? "agente", .ok)
            case "ci": return ("CI", .info)
            default: return (item.kind, .neutral)
            }
        }()
        return Chip(text: text, tone: tone).fixedSize()
    }
}

/// Una mejora propuesta por un agente: dónde se arregla, qué y por qué; abrirla como issue o descartarla.
struct ImprovementRow: View {
    @ObservedObject var runner: RunnerModel
    let improvement: Improvement

    var body: some View {
        let busy = runner.busy.contains(improvement.id)
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Chip(text: target, tone: .info).fixedSize()
                Text(improvement.repo.split(separator: "/").last.map(String.init) ?? improvement.repo)
                    .font(.lh(11)).foregroundStyle(.secondary).lineLimit(1)
                Text([ago(improvement.created_at), "de \(improvement.task_ref.split(separator: "/").last.map { String($0) } ?? improvement.task_ref)"]
                        .compactMap { $0 }.joined(separator: " · "))
                    .font(.lh(11)).foregroundStyle(.tertiary).lineLimit(1)
                Spacer(minLength: 0)
            }
            Text(improvement.title).font(.lh(13, .semibold)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
            Text(improvement.reason).font(.lh(11.5)).foregroundStyle(.secondary).lineLimit(3).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                Button { runner.decide(improvement, open: true) } label: {
                    if busy { ProgressView().controlSize(.small).scaleEffect(0.5).frame(width: 40, height: 14) } else { Text("Abrir issue…") }
                }
                .buttonStyle(PillButtonStyle(tint: .accentColor, compact: true)).fixedSize().disabled(busy)
                Button("Descartar…") { runner.decide(improvement, open: false) }
                    .buttonStyle(PillButtonStyle(tint: .secondary, compact: true)).fixedSize().disabled(busy)
                Spacer(minLength: 0)
                Menu {
                    Button("Abrir la tarea \(improvement.task_ref)") { runner.openTask(improvement.task_ref) }
                    if let pr = improvement.pr_url, let url = URL(string: pr) { Button("Abrir el PR") { NSWorkspace.shared.open(url) } }
                    Button("Copiar el cuerpo del issue") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(improvement.body, forType: .string)
                    }
                } label: {
                    Image(systemName: "ellipsis").font(.system(size: 12, weight: .semibold)).frame(width: 24, height: 20).contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().foregroundStyle(.secondary)
            }
            .padding(.top, 2)
        }
        .help(improvement.body)
    }

    private var target: String {
        switch improvement.target {
        case "docs": return "docs"
        case "config": return "config del runner"
        case "engine": return "ia-flow"
        default: return improvement.target
        }
    }
}

struct CompactRow: View {
    @ObservedObject var runner: RunnerModel
    let item: InboxItem

    var body: some View {
        Button { runner.open(item) } label: {
            HStack(spacing: 6) {
                Text(item.shortRef).font(.lh(11.5, .bold)).foregroundStyle(.secondary)
                Text(item.displayTitle).font(.lh(12)).lineLimit(1)
                Spacer()
                Text(item.kind == "dep" ? "bloqueada" : "turno").font(.lh(11)).foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(item.why)
    }
}

/// Una épica: avance de sus sub-issues y la próxima tarea que la mueve, con su acción a mano.
struct EpicRow: View {
    @ObservedObject var runner: RunnerModel
    let epic: EpicView

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Button { runner.openEpic(epic.epic) } label: { Text(epic.epic.displayTitle).font(.lh(13, .semibold)).lineLimit(2).multilineTextAlignment(.leading) }
                    .buttonStyle(.plain).help("Abrir \(epic.epic.ref)")
                Spacer()
                Text("\(epic.epic.done)/\(epic.epic.total)").font(.lh(11.5, .semibold)).foregroundStyle(.secondary)
            }
            ProgressBar(value: epic.progress)
            if let next = epic.next {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(next.isDecision ? "Sigue" : next.group == "run" ? "Corre" : "Espera").font(.lh(11, .bold))
                        .foregroundStyle(next.isDecision ? Color.orange : .secondary)
                    Button { runner.open(next) } label: {
                        Text("\(next.shortRef) · \(next.displayTitle)").font(.lh(11.5)).foregroundStyle(.primary.opacity(0.8)).lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    .buttonStyle(.plain)
                    Spacer(minLength: 4)
                    if next.isDecision, let action = actionsOf(next).first {
                        Button(action.confirms ? "\(action.label)…" : action.label) { runner.trigger(action, on: next) }
                            .buttonStyle(PillButtonStyle(tint: .accentColor, compact: true)).fixedSize().disabled(runner.busy.contains(next.ref))
                    }
                }
            }
            if epic.items.count > 1 {
                Text(summary).font(.lh(11)).foregroundStyle(.tertiary)
            }
        }
    }

    private var summary: String {
        let decisions = epic.items.filter(\.isDecision).count
        var parts: [String] = []
        if decisions > 0 { parts.append("\(decisions) te esperan") }
        if epic.running > 0 { parts.append("\(epic.running) corriendo") }
        let rest = epic.items.count - decisions - epic.running
        if rest > 0 { parts.append("\(rest) en cola") }
        return parts.joined(separator: " · ")
    }
}

struct ProgressBar: View {
    let value: Double

    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.08))
                Capsule().fill(Color.green.opacity(0.8)).frame(width: max(g.size.width * value, value > 0 ? 6 : 0))
            }
        }
        .frame(height: 5)
    }
}

/// El código del device flow: ya está copiado y la página de GitHub abierta; esto espera la confirmación.
struct DeviceLoginCard: View {
    @ObservedObject var runner: RunnerModel
    let login: DeviceLogin

    var body: some View {
        Banner(text: login.error ?? "Pega el código en la página de GitHub que se abrió (ya está copiado). Espero la confirmación…",
               tone: login.error == nil ? .info : .bad, icon: "key.fill") {
            HStack {
                Text(login.code.user_code).font(.system(size: 16, weight: .bold, design: .monospaced)).textSelection(.enabled)
                Spacer()
                if login.error != nil {
                    Button("Reintentar") { runner.beginLogin() }.buttonStyle(PillButtonStyle(prominent: true))
                } else {
                    ProgressView().controlSize(.small).scaleEffect(0.6)
                }
                Button("Cancelar") { runner.login = nil }.buttonStyle(PillButtonStyle(tint: .secondary))
            }
        }
    }
}

/// Responder a una tarea bloqueada (u otra acción que pide texto): sobre la pantalla, como las confirmaciones.
struct CommentCard: View {
    @ObservedObject var runner: RunnerModel

    var body: some View {
        if let request = runner.comment {
            VStack(alignment: .leading, spacing: 10) {
                Text("\(request.action.label) · \(request.item.shortRef)").font(.lh(14, .bold))
                Text(request.item.agent_said ?? request.item.why).font(.lh(12)).foregroundStyle(.secondary).lineLimit(5)
                TextEditor(text: Binding(get: { runner.comment?.text ?? "" }, set: { runner.comment?.text = $0 }))
                    .font(.lh(13)).frame(height: 90).scrollContentBackground(.hidden)
                    .padding(6).background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.primary.opacity(0.06)))
                HStack {
                    Spacer()
                    Button("Cancelar") { runner.comment = nil }.buttonStyle(PillButtonStyle(tint: .secondary)).keyboardShortcut(.cancelAction)
                    let empty = request.action.comment == "required" && request.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    Button("Enviar") { runner.submitComment() }
                        .buttonStyle(PillButtonStyle(prominent: true, enabled: !empty)).disabled(empty)
                        .keyboardShortcut(.return, modifiers: .command)
                }
            }
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.regularMaterial))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.primary.opacity(0.15)))
            .shadow(color: .black.opacity(0.25), radius: 14, y: 4)
        }
    }
}

// MARK: logs

struct RunnerLogsScreen: View {
    @ObservedObject var runner: RunnerModel

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                IconButton(symbol: "chevron.left", help: "Volver") { runner.screen = .inbox }
                VStack(alignment: .leading, spacing: 1) {
                    Text("Logs del server").font(.lh(17, .bold))
                    Text(runner.selected.name).font(.lh(12)).foregroundStyle(.secondary)
                }
                Spacer()
                Picker("", selection: $runner.logLevel) {
                    ForEach(["debug", "info", "warn", "error"], id: \.self) { Text($0).tag($0) }
                }
                .pickerStyle(.segmented).labelsHidden().frame(width: 190)
            }
            .padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 10)

            if let error = runner.logError {
                Banner(text: error, tone: .bad, icon: "xmark.octagon.fill").padding(.horizontal, 14).padding(.bottom, 8)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 3) {
                        if runner.logLines.isEmpty, runner.logError == nil {
                            Text("Sin líneas todavía.").font(.lh(12)).foregroundStyle(.tertiary)
                        }
                        ForEach(runner.logLines) { line in LogLineView(line: line).id(line.seq) }
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(height: popoverMaxScroll)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.primary.opacity(0.045)))
                .padding(.horizontal, 14).padding(.bottom, 12)
                .onChange(of: runner.logLines.last?.seq) { _, seq in
                    if let seq { proxy.scrollTo(seq, anchor: .bottom) }
                }
            }
            Divider().opacity(0.5)
            HStack {
                Text("\(runner.logLines.count) líneas · se actualiza solo").font(.lh(12)).foregroundStyle(.secondary)
                Spacer()
                IconButton(symbol: "doc.on.doc", help: "Copiar") { runner.copyLogs() }
                IconButton(symbol: "trash", help: "Limpiar la vista") { runner.resetLogs(); runner.pollLogs() }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
        }
    }
}

struct LogLineView: View {
    let line: RunnerLogLine

    var body: some View {
        (Text(String(line.time.dropFirst(11).prefix(8))).foregroundColor(.secondary)
         + Text(" \(line.level.uppercased().padding(toLength: 5, withPad: " ", startingAt: 0)) ").foregroundColor(tone.color).bold()
         + Text("[\(line.scope)] ").foregroundColor(.secondary)
         + Text(line.message)
         + Text(line.fields.map { "  \($0)" } ?? "").foregroundColor(.secondary))
            .font(.system(size: 10.5, design: .monospaced))
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var tone: Tone {
        switch line.level {
        case "error": return .bad
        case "warn": return .warn
        case "debug": return .neutral
        default: return .info
        }
    }
}
