import SwiftUI

// Las pantallas del runner que se abren encima de la bandeja (con su ruta de vuelta) y las piezas que comparten las
// vistas: la fila de una tarea, el buscador, las filas del board y de lo que corrió, el login y los logs. Sólo dibuja
// lo que publica RunnerModel; las acciones van al modelo.

struct RunnerScreen: View {
    @ObservedObject var runner: RunnerModel

    var body: some View {
        switch runner.screen {
        case .logs: RunnerLogsScreen(runner: runner)
        case .health: RunnerHealthScreen(runner: runner)
        case .github:
            if let model = runner.githubSearch { GithubSearchScreen(runner: runner, model: model) } else { gone }
        case .improvements: ImprovementsScreen(runner: runner)
        case .improvement:
            if let improvement = runner.discussing, let chat = runner.improvementChat {
                ImprovementChatScreen(runner: runner, improvement: improvement, chat: chat)
            } else { ImprovementsScreen(runner: runner) }
        case .run, .task:
            if let watch = runner.watching { RunTraceScreen(runner: runner, watch: watch) } else { gone }
        case .epic:
            if runner.epicRef != nil { EpicScreen(runner: runner) } else { gone }
        // la bandeja y «Runners» los dibuja RootContent
        case .inbox, .runners: gone
        }
    }

    /// Lo que la pantalla mostraba ya no está (se cambió de runner): la ruta de vuelta y nada más.
    private var gone: some View {
        RouteHeader(back: runner.backLabel, title: "") { runner.goBack() }.padding(14)
    }
}

/// Una tarea: qué caso es y hace cuánto, el título, por qué está acá y sus acciones. Sólo la primera decisión de la
/// pantalla lleva su botón a la vista (como «Lo primero» de la web, un solo primario); las demás son cortas —el título
/// en dos líneas, sin botones— y sus acciones salen deslizándolas a la izquierda o con clic derecho. Un clic en la
/// fila abre su detalle (la traza, con todas sus acciones al pie); el `#n` abre el issue.
struct TaskRow: View {
    @ObservedObject var runner: RunnerModel
    let item: InboxItem
    var primary = false

    var body: some View {
        SwipeRow(id: "task:\(item.ref)", actions: primary ? [] : swipeActions) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    kindChip
                    Text(meta).font(.lh(11)).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 4)
                    Button { runner.open(item) } label: { refTag(item.ref) }
                        .buttonStyle(.plain).help("Abrir \(item.ref) en GitHub")
                }
                Text(item.displayTitle).font(.lh(13, .semibold)).lineLimit(2).multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let agents = item.execution?.parallelAgents {
                    AgentsLine(entries: agents.map { AgentEntry(id: $0.agent_id, agent: $0) })
                }
                BlockersLine(runner: runner, item: item)
                if primary {
                    if let said = item.agent_said, item.isDecision {
                        Text("«\(said)»").font(.lh(11.5)).italic().foregroundStyle(.primary.opacity(0.7)).lineLimit(3)
                    }
                    actionLine
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { runner.showTask(item) }
            .help(primary ? item.title : "\(item.title)\n\nClic: detalle · desliza a la izquierda o clic derecho: acciones")
        }
        .contextMenu { TaskMenu(runner: runner, item: item) }
    }

    /// Lo que destapa el deslizamiento: la acción del caso y el detalle.
    private var swipeActions: [SwipeAction] {
        var out: [SwipeAction] = []
        if let first = mainAction(actionsOf(item)), !runner.busy.contains(item.ref) {
            out.append(SwipeAction(id: first.id, icon: icon(first.id), label: first.label, color: first.id == "stop" ? Palette.red : Palette.blue) {
                runner.trigger(first, on: item)
            })
        }
        let live = item.execution?.status == "running"
        out.append(SwipeAction(id: "watch", icon: live ? "dot.radiowaves.left.and.right" : "list.bullet.rectangle",
                               label: live ? "En vivo" : "Detalle", color: .gray) { live ? runner.watch(item) : runner.showTask(item) })
        return out
    }

    private func icon(_ action: String) -> String {
        switch action {
        case "merge": return "arrow.triangle.merge"
        case "approve_prd": return "checkmark.seal"
        case "stop": return "stop.fill"
        case "answer_and_unblock", "comment": return "text.bubble"
        case "retry", "relaunch", "rerun_review", "rerun_stage": return "arrow.clockwise"
        default: return "bolt.fill"
        }
    }

    /// La fila de botones de la primera decisión: su acción, «En vivo», el PR, la épica y el ⋯.
    private var actionLine: some View {
        let actions = actionsOf(item)
        let busy = runner.busy.contains(item.ref)
        return HStack(spacing: 6) {
            if let first = mainAction(actions) {
                Button { runner.trigger(first, on: item) } label: {
                    if busy { ProgressView().controlSize(.small).scaleEffect(0.5).frame(width: 40, height: 14) }
                    else { Text(first.confirms ? "\(first.label)…" : first.label) }
                }
                .buttonStyle(PillButtonStyle(prominent: true, tint: first.id == "stop" ? Palette.red : Palette.blue, compact: true))
                .fixedSize()
                .disabled(busy)
            }
            if let pr = item.pr {
                Button { runner.openPR(item) } label: { Chip(text: "PR #\(pr.number)", tone: .info, icon: "arrow.up.right") }
                    .buttonStyle(.plain).fixedSize()
            }
            if let epic = item.epic {
                Button { runner.showEpic(epic.ref) } label: {
                    Chip(text: "\(shortRef(epic.ref)) · \(epic.done)/\(epic.total) · \(epic.displayTitle)", tone: .info, icon: "square.stack.3d.up")
                }
                .buttonStyle(.plain)
                .help("Épica \(epic.ref): \(epic.title)\n\nClic: ver sus sub-issues")
            }
            Spacer(minLength: 0)
            Menu { TaskMenu(runner: runner, item: item, skip: mainAction(actionsOf(item))?.id) } label: {
                Image(systemName: "ellipsis").font(.system(size: 12, weight: .semibold)).frame(width: 24, height: 20).contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().foregroundStyle(.secondary)
        }
        .padding(.top, 2)
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
            // con agentes en paralelo, el pipeline: cada agente va en su línea, bajo el título
            case "agent":
                if let execution = item.execution, execution.parallelAgents != nil { return (execution.pipeline_id, .ok) }
                return (item.execution?.agentLabel ?? "agente", .ok)
            case "ci": return ("CI", .info)
            default: return (item.kind, .neutral)
            }
        }()
        return Chip(text: text, tone: tone).fixedSize()
    }
}

/// El campo del buscador: número, `repo#n`, `owner/repo#n`, link de GitHub o texto del título. Esc lo limpia.
struct SearchField: View {
    @ObservedObject var runner: RunnerModel
    @FocusState private var focused: Bool

    var body: some View {
        FieldBox {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                repoMenu
                TextField("Número, link o texto", text: $runner.query)
                    .focused($focused)
                    .onExitCommand { runner.clearSearch() }
                if runner.searching { ProgressView().controlSize(.small).scaleEffect(0.5).frame(width: 14, height: 14) }
                if runner.filtering {
                    Text("\(runner.resultCount)").font(.lh(11, .semibold)).foregroundStyle(.secondary)
                    Button { runner.clearSearch(); runner.repoFilter = nil } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain).help("Limpiar búsqueda y repo")
                }
            }
        }
    }

    /// El selector de repo: un tag al inicio del campo («Todos» o el repo, con su color).
    private var repoMenu: some View {
        Menu {
            Button { runner.repoFilter = nil } label: {
                if runner.repoFilter == nil { Label("Todos los repos", systemImage: "checkmark") } else { Text("Todos los repos") }
            }
            Divider()
            ForEach(runner.repos, id: \.name) { repo in
                Button { runner.repoFilter = repo.name } label: {
                    let title = repo.count > 0 ? "\(repo.name)  ·  \(repo.count)" : repo.name
                    if runner.repoFilter == repo.name { Label(title, systemImage: "checkmark") } else { Text(title) }
                }
            }
        } label: {
            if let repo = runner.repoFilter {
                RepoTag(repo: repo, chevron: true)
            } else {
                HStack(spacing: 3) {
                    Text("Todos").font(.lh(10.5, .semibold))
                    Image(systemName: "chevron.down").font(.system(size: 7.5, weight: .bold)).opacity(0.7)
                }
                .padding(.horizontal, 7).padding(.vertical, 2.5)
                .foregroundStyle(.secondary)
                .background(Capsule().fill(Color.primary.opacity(0.08)))
                .fixedSize()
            }
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
        .help("Filtrar por repo")
    }
}

/// `subscriptions #1775` como tag del color del repo.
func refTag(_ ref: String) -> some View {
    let parts = RunnerSearch.split(ref)
    return RepoTag(repo: parts?.repo ?? ref, number: parts?.number)
}

/// Una card del board fuera de la bandeja: su columna y el título; clic la abre en GitHub.
struct BoardRow: View {
    @ObservedObject var runner: RunnerModel
    let item: BoardItem

    var body: some View {
        Button { runner.openTask(item.ref) } label: {
            HStack(spacing: 6) {
                if let status = item.status { Chip(text: status).fixedSize() }
                Text(cleanTitle(item.title)).font(.lh(12)).lineLimit(1)
                Spacer(minLength: 4)
                refTag(item.ref)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(item.title)
    }
}

/// Una corrida que ya cerró: cómo terminó (✓ ✕ ↷), la tarea, quién, la salida si no fue la de siempre y hace
/// cuánto. Un clic abre su detalle (la traza de esa ejecución).
struct RecentRow: View {
    @ObservedObject var runner: RunnerModel
    let item: InboxItem

    var body: some View {
        let run = item.execution
        let status = run?.status ?? "done"
        Button { runner.showTask(item) } label: {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Image(systemName: Self.symbol(status)).font(.system(size: 10, weight: .bold))
                    .foregroundStyle(Self.tone(status) == .bad ? Color.red : status == "superseded" ? .secondary : .green)
                    .frame(width: 12)
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.displayTitle).font(.lh(12)).lineLimit(1)
                    Text(detail(run)).font(.lh(10.5)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 4)
                refTag(item.ref)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("\(item.title)\n\nClic: ver lo que hizo")
    }

    private func detail(_ run: ExecutionSummary?) -> String {
        guard let run else { return "" }
        var parts = [run.parallelAgents != nil ? run.pipeline_id : (run.agentLabel ?? run.pipeline_id)]
        if run.status == "failed" { parts.append("falló") }
        else if let exit = run.exit, exit != "done" { parts.append("→ \(exit)") }
        if let age = run.closed_at.flatMap({ ago($0) }) { parts.append(age == "ahora" ? age : "hace \(age)") }
        return parts.joined(separator: " · ")
    }

    static func symbol(_ status: String) -> String {
        status == "failed" ? "xmark" : status == "superseded" ? "arrow.uturn.right" : "checkmark"
    }

    static func tone(_ status: String) -> Tone {
        status == "failed" ? .bad : status == "superseded" ? .neutral : .ok
    }
}

/// «Espera #4281 · destraba 3»: quién la bloquea (un clic lleva a esa tarea) y cuántas destraba ella.
struct BlockersLine: View {
    @ObservedObject var runner: RunnerModel
    let item: InboxItem

    var body: some View {
        let blockers = item.blocked_by ?? []
        if !blockers.isEmpty || (item.unlocks ?? 0) > 0 {
            HStack(spacing: 5) {
                if !blockers.isEmpty {
                    Text("Espera").font(.lh(11)).foregroundStyle(.secondary)
                    ForEach(blockers, id: \.self) { ref in
                        Button { runner.goTo(ref) } label: { Chip(text: shortRef(ref), tone: .warn, icon: "lock.fill") }
                            .buttonStyle(.plain).fixedSize().help("Ver \(ref)")
                    }
                }
                if let unlocks = item.unlocks, unlocks > 0 {
                    Chip(text: "destraba \(unlocks)", tone: .ok, icon: "lock.open.fill").fixedSize()
                        .help("Cerrarla destraba \(unlocks) tarea\(unlocks == 1 ? "" : "s")")
                }
            }
        }
    }
}

/// Todo lo que se hace con una tarea, en un solo menú (el ⋯ y el clic derecho): sus acciones, preguntar, ver la última
/// ejecución, moverla, el worktree, GitHub y copiar la ref; «Detener…» al final, en rojo. `skip`: la que ya está a la vista.
struct TaskMenu: View {
    @ObservedObject var runner: RunnerModel
    let item: InboxItem
    var skip: String? = nil

    var body: some View {
        let actions = actionsOf(item).filter { $0.id != skip && $0.id != "stop" }
        ForEach(actions) { action in
            Button(action.confirms ? "\(action.label)…" : action.label) { runner.trigger(action, on: item) }
        }
        if !actions.isEmpty { Divider() }
        Button("✦ Preguntar sobre esta tarea") { runner.onAsk?(item) }
        Button(item.execution?.status == "running" ? "Ver en vivo" : "Ver la última ejecución") { runner.watch(item) }
        let columns = runner.destinations(ref: item.ref, project: item.project_id, status: item.status)
        if !columns.isEmpty {
            Menu("Mover a") {
                ForEach(columns, id: \.self) { status in Button(status) { runner.move(ref: item.ref, to: status) } }
                Divider()
                Text("Se mueve con tu login, sin confirmar.")
            }
        }
        Button(item.pr == nil ? "Abrir worktree del issue en iTerm" : "Abrir worktree del PR en iTerm") { runner.openWorktree(item) }
        Divider()
        Button("Abrir el issue en GitHub ↗") { runner.open(item) }
        if let pr = item.pr { Button("Abrir el PR #\(pr.number) ↗") { runner.openPR(item) } }
        if let epic = item.epic {
            Button("Ver la épica \(shortRef(epic.ref)) y sus sub-issues") { runner.showEpic(epic.ref) }
        }
        ForEach(item.blocked_by ?? [], id: \.self) { ref in Button("Ver \(shortRef(ref)), que la bloquea") { runner.goTo(ref) } }
        let short = item.ref.split(separator: "/").last.map(String.init) ?? item.ref
        Button("Copiar \(short)") { runner.copy(short) }
        if skip != "stop", let stop = actionsOf(item).first(where: { $0.id == "stop" }) {
            Divider()
            Button("Detener…", role: .destructive) { runner.trigger(stop, on: item) }
        }
    }
}

/// `la-haus/subscriptions#4281` → `#4281`.
func shortRef(_ ref: String) -> String { ref.split(separator: "#").last.map { "#\($0)" } ?? ref }

/// Una épica: avance de sus sub-issues y la próxima tarea que la mueve, con su acción a mano.
struct EpicRow: View {
    @ObservedObject var runner: RunnerModel
    let epic: EpicView

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Button { runner.showEpic(epic.epic.ref) } label: {
                    (Text(shortRef(epic.epic.ref)).foregroundStyle(.secondary) + Text(" ") + Text(epic.epic.displayTitle))
                        .font(.lh(13, .semibold)).lineLimit(2).multilineTextAlignment(.leading)
                }
                .buttonStyle(.plain).help("Ver \(epic.epic.ref) y sus sub-issues")
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
                    if next.isDecision, let action = mainAction(actionsOf(next)) {
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
                IconButton(symbol: "chevron.left", help: "Volver") { runner.goBack() }
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
                        if !runner.logsLoaded, runner.logError == nil {
                            HStack(spacing: 8) {
                                ProgressView().controlSize(.small)
                                Text("Cargando logs…").font(.lh(12)).foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity).padding(.vertical, 24)
                        } else if runner.logLines.isEmpty, runner.logError == nil {
                            Text("Sin líneas todavía.").font(.lh(12)).foregroundStyle(.secondary)
                        }
                        ForEach(runner.logLines) { line in LogLineView(line: line).id(line.seq) }
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .scrollHeight(popoverMaxScroll)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.primary.opacity(0.045)))
                .padding(.horizontal, 14).padding(.bottom, 12)
                .onChange(of: runner.logLines.last?.seq) { _, seq in
                    if let seq { proxy.scrollTo(seq, anchor: .bottom) }
                }
            }
            Divider().opacity(0.5)
            HStack {
                Text(runner.logsLoaded ? "\(runner.logLines.count) líneas · se actualiza solo" : "Cargando…")
                    .font(.lh(12)).foregroundStyle(.secondary)
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
