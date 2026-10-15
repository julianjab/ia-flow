import AppKit
import SwiftUI

// El estado de la pestaña «Runner»: el server elegido, su bandeja (ya clasificada por el runner), las épicas que
// salen de ella, el log del proceso y las acciones sobre una tarea firmadas con el login de GitHub de la persona.
// La bandeja se relee cada pocos segundos con el popover abierto y cada minuto cerrado (para el badge del ícono).

/// Una épica tal como la ve el menú: su avance y la próxima cosa que la destraba.
struct EpicView: Identifiable {
    let epic: TaskEpic
    let items: [InboxItem]
    var id: String { epic.ref }

    /// La primera decisión (en el orden de prioridad del runner); si no hay, lo que corre; si no, lo que espera.
    var next: InboxItem? {
        items.filter(\.isDecision).min { ($0.priority ?? .max) < ($1.priority ?? .max) }
            ?? items.first { $0.group == "run" } ?? items.first
    }
    var running: Int { items.filter { $0.group == "run" }.count }
    var progress: Double { epic.total == 0 ? 0 : Double(epic.done) / Double(epic.total) }
}

extension InboxItem {
    /// Lo que espera a una persona: `need` y `fail`.
    var isDecision: Bool { group == "need" || group == "fail" }
    var displayTitle: String { cleanTitle(title) }
    /// Hace cuánto está en este estado («3 h», «2 d»).
    var age: String? { ago(since) }
}

extension TaskEpic {
    var displayTitle: String { cleanTitle(title) }
}

/// Sin el prefijo de Conventional Commits (`feat(crm): `) que traen los títulos de los issues: en 420 pt ocupa
/// el lugar de lo que dice el título.
func cleanTitle(_ title: String) -> String {
    let stripped = title.replacingOccurrences(of: #"^[a-z]+(\([^)]*\))?!?:\s*"#, with: "", options: .regularExpression)
    guard let first = stripped.first, !stripped.isEmpty else { return title }
    return first.uppercased() + stripped.dropFirst()
}

private let isoFractional: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

func ago(_ iso: String, now: Date = Date()) -> String? {
    guard let date = isoFractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return nil }
    let minutes = Int(now.timeIntervalSince(date) / 60)
    if minutes < 1 { return "ahora" }
    if minutes < 60 { return "\(minutes) min" }
    if minutes < 48 * 60 { return "\(minutes / 60) h" }
    return "\(minutes / 1440) d"
}

/// Una acción como la dibuja el menú (las mismas reglas que `apps/web/src/features/inbox/queue/kinds.ts`).
struct ActionView: Identifiable {
    let id: String
    let label: String
    let confirms: Bool
    let comment: String?
    let confirmText: String?
}

private let shortLabel = [
    "merge": "Mergear", "approve_prd": "Aprobar", "rerun_review": "Re-review", "answer_and_unblock": "Responder",
    "relaunch": "Relanzar", "retry": "Reintentar", "stop": "Detener", "back_to_refine": "Devolver a Refine",
]
/// Las que firman con GitHub o no se deshacen.
private let confirming: Set<String> = ["merge", "approve_prd", "stop"]
/// La principal de cada caso, si el runner la ofrece.
private let primaryByKind = [
    "merge": "merge", "prd": "approve_prd", "doubt": "answer_and_unblock", "prerequisite": "answer_and_unblock",
    "crash": "retry", "stale": "relaunch", "review": "rerun_review",
]

func actionsOf(_ item: InboxItem) -> [ActionView] {
    let primary = primaryByKind[item.kind]
    let rank = { (id: String) in id == primary ? 0 : id == "stop" ? 2 : 1 }
    return item.actions.sorted { rank($0) < rank($1) }.map { id in
        let def = item.action_defs?.first { $0.id == id }
        return ActionView(id: id, label: def?.label ?? shortLabel[id] ?? id,
                          confirms: confirming.contains(id) || def?.confirm != nil,
                          comment: def?.comment ?? (id == "answer_and_unblock" ? "required" : nil),
                          confirmText: def?.confirm)
    }
}

/// Una acción que pide un texto antes de salir (Responder).
struct CommentRequest {
    let item: InboxItem
    let action: ActionView
    var text = ""
}

struct DeviceLogin {
    let code: DeviceCode
    var error: String?
}

final class RunnerModel: ObservableObject {
    enum Screen { case inbox, logs }

    @Published private(set) var servers: [RunnerServer]
    @Published private(set) var selected: RunnerServer
    @Published private(set) var inbox: Inbox?
    @Published private(set) var error: RunnerError?
    @Published private(set) var loading = false
    @Published var screen: Screen = .inbox
    @Published var comment: CommentRequest?
    @Published var login: DeviceLogin?
    /// Las refs con una acción en vuelo: su botón no se puede volver a tocar.
    @Published private(set) var busy: Set<String> = []

    /// Las secciones colapsadas de la bandeja, por título. «En cola» arranca colapsada.
    @Published private(set) var collapsed: Set<String> =
        Set(UserDefaults.standard.stringArray(forKey: "runnerCollapsed") ?? ["En cola"])

    @Published fileprivate(set) var logLines: [RunnerLogLine] = []
    @Published var logLevel: String = "info" { didSet { resetLogs() } }
    @Published private(set) var logError: String?
    private var lastSeq = 0

    private var sessions = loadGithubSessions()
    /// Avisa al ícono (el badge) y a quien muestre los toasts.
    var onBadge: ((Int) -> Void)?
    var toast: ((String) -> Void)?
    var confirm: ((ConfirmRequest) -> Void)?
    let isFixture: Bool

    init(servers: [RunnerServer]? = nil, inbox: Inbox? = nil) {
        isFixture = servers != nil
        let list = servers ?? loadRunnerServers()
        self.servers = list
        let saved = UserDefaults.standard.string(forKey: "runnerServer")
        selected = list.first { $0.baseUrl == saved } ?? list[0]
        self.inbox = inbox
    }

    private var client: RunnerClient { RunnerClient(server: selected) }

    // MARK: lo que se muestra

    var decisions: [InboxItem] {
        (inbox?.items ?? []).filter(\.isDecision).sorted { ($0.priority ?? .max) < ($1.priority ?? .max) }
    }
    var running: [InboxItem] { (inbox?.items ?? []).filter { $0.group == "run" } }
    var queued: [InboxItem] { (inbox?.items ?? []).filter { $0.group == "queue" } }
    /// El badge: lo que te espera a vos.
    var pendingCount: Int { decisions.count }

    var epics: [EpicView] {
        var order: [String] = []
        var byRef: [String: (TaskEpic, [InboxItem])] = [:]
        for item in inbox?.items ?? [] {
            guard let epic = item.epic else { continue }
            if byRef[epic.ref] == nil { order.append(epic.ref); byRef[epic.ref] = (epic, []) }
            byRef[epic.ref]?.1.append(item)
        }
        // Primero las que esperan una decisión, después las que corren, al final las que sólo esperan turno.
        let views = order.compactMap { byRef[$0].map { EpicView(epic: $0.0, items: $0.1) } }
        let rank = { (e: EpicView) in e.items.contains(where: \.isDecision) ? 0 : e.running > 0 ? 1 : 2 }
        return views.sorted { rank($0) < rank($1) }
    }

    var github: GithubSession? { sessions[selected.baseUrl] }

    var boardURL: URL? { (inbox?.projects.first?.board_url ?? inbox?.projects.first?.url).flatMap(URL.init(string:)) }

    func isCollapsed(_ section: String) -> Bool { collapsed.contains(section) }

    func toggleSection(_ section: String) {
        if collapsed.contains(section) { collapsed.remove(section) } else { collapsed.insert(section) }
        if !isFixture { UserDefaults.standard.set(Array(collapsed), forKey: "runnerCollapsed") }
    }

    // MARK: servers

    func select(_ server: RunnerServer) {
        guard server != selected else { return }
        selected = server
        UserDefaults.standard.set(server.baseUrl, forKey: "runnerServer")
        inbox = nil
        error = nil
        login = nil
        comment = nil
        resetLogs()
        refresh()
    }

    func reloadServers() {
        guard !isFixture else { return }
        servers = loadRunnerServers()
        if let fresh = servers.first(where: { $0.baseUrl == selected.baseUrl }) { selected = fresh } else { selected = servers[0] }
    }

    // MARK: bandeja

    func refresh() {
        guard !isFixture, !loading else { return }
        loading = true
        let server = selected
        Task { @MainActor in
            defer { loading = false }
            do {
                let fresh = try await RunnerClient(server: server).inbox()
                guard server == selected else { return }
                inbox = fresh
                error = nil
            } catch let e as RunnerError {
                guard server == selected else { return }
                error = e
            } catch {
                self.error = RunnerError(status: 0, message: error.localizedDescription)
            }
            onBadge?(error == nil ? pendingCount : 0)
        }
    }

    func open(_ item: InboxItem) { _ = URL(string: item.url).map { NSWorkspace.shared.open($0) } }
    func openPR(_ item: InboxItem) { _ = item.pr.flatMap { URL(string: $0.url) }.map { NSWorkspace.shared.open($0) } }
    func openEpic(_ epic: TaskEpic) { NSWorkspace.shared.open(githubURL(epic.ref)) }
    func openBoard() { _ = boardURL.map { NSWorkspace.shared.open($0) } }
    func openServersFile() {
        let path = FileManager.default.fileExists(atPath: runnersPath) ? runnersPath : desktopServersPath
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    private func githubURL(_ ref: String) -> URL {
        let parts = ref.split(whereSeparator: { $0 == "#" }).map(String.init)
        return URL(string: "https://github.com/\(parts.first ?? "")/issues/\(parts.last ?? "")")!
    }

    // MARK: acciones

    /// Lo que pide un paso más (confirmar o escribir) lo pide; lo demás sale directo.
    func trigger(_ action: ActionView, on item: InboxItem) {
        if action.comment != nil { comment = CommentRequest(item: item, action: action); return }
        guard action.confirms else { return send(action, on: item, comment: nil) }
        confirm?(ConfirmRequest(
            title: "¿\(action.label) \(item.shortRef)?",
            detail: action.confirmText ?? "\(item.title)\n\nSe firma con tu login de GitHub\(github.map { " (\($0.login))" } ?? "").",
            confirmLabel: "\(action.label) ahora", destructive: action.id == "stop"
        ) { [weak self] in self?.send(action, on: item, comment: nil) })
    }

    func submitComment() {
        guard let request = comment else { return }
        let text = request.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if request.action.comment == "required", text.isEmpty { return }
        comment = nil
        send(request.action, on: request.item, comment: text.isEmpty ? nil : text)
    }

    private func send(_ action: ActionView, on item: InboxItem, comment: String?) {
        let server = selected
        Task { @MainActor in
            guard let session = await validSession() else {
                toast?("Inicia sesión con GitHub para \(action.label.lowercased())")
                return beginLogin()
            }
            busy.insert(item.ref)
            let result = (try? await RunnerClient(server: server).act(item, action: action.id, comment: comment, github: session.token))
                ?? TaskActionResult(ok: false, message: "No responde \(server.name)")
            busy.remove(item.ref)
            toast?(result.ok ? "\(item.shortRef): \(result.message)" : "No se pudo: \(result.message)")
            refresh()
        }
    }

    // MARK: login de GitHub (device flow, por server)

    /// La sesión del server, renovada si venció; sin sesión o sin poder renovarla, nil.
    @MainActor private func validSession() async -> GithubSession? {
        guard var session = sessions[selected.baseUrl] else { return nil }
        guard session.expired else { return session }
        guard let refresh = session.refreshToken, let fresh = try? await client.refresh(refresh), let token = fresh.access_token else {
            sessions[selected.baseUrl] = nil
            saveGithubSessions(sessions)
            return nil
        }
        session = GithubSession(token: token, login: fresh.login ?? session.login,
                                expiresAt: fresh.expires_in.map { Date().timeIntervalSince1970 + $0 },
                                refreshToken: fresh.refresh_token ?? refresh)
        sessions[selected.baseUrl] = session
        saveGithubSessions(sessions)
        return session
    }

    func beginLogin() {
        let server = selected
        Task { @MainActor in
            do {
                let code = try await RunnerClient(server: server).deviceStart()
                login = DeviceLogin(code: code)
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(code.user_code, forType: .string)
                _ = URL(string: code.verification_uri).map { NSWorkspace.shared.open($0) }
                await poll(code, server: server)
            } catch {
                toast?("No se pudo iniciar el login: \(error.localizedDescription)")
            }
        }
    }

    @MainActor private func poll(_ code: DeviceCode, server: RunnerServer) async {
        var interval = UInt64(max(code.interval, 5))
        let deadline = Date().addingTimeInterval(TimeInterval(code.expires_in))
        while Date() < deadline, login?.code.device_code == code.device_code {
            try? await Task.sleep(nanoseconds: interval * 1_000_000_000)
            guard let result = try? await RunnerClient(server: server).devicePoll(code.device_code) else { continue }
            switch result.status {
            case "ok":
                guard let token = result.access_token, let user = result.login else { return }
                sessions[server.baseUrl] = GithubSession(token: token, login: user,
                                                         expiresAt: result.expires_in.map { Date().timeIntervalSince1970 + $0 },
                                                         refreshToken: result.refresh_token)
                saveGithubSessions(sessions)
                login = nil
                toast?("Sesión de GitHub: \(user)")
                return
            case "slow_down": interval += 5
            case "pending": continue
            default:
                login?.error = result.status == "denied" ? "Rechazaste el acceso en GitHub." : "El código venció."
                return
            }
        }
    }

    func logout() {
        sessions[selected.baseUrl] = nil
        saveGithubSessions(sessions)
        objectWillChange.send()
    }

    // MARK: log del server

    func resetLogs() {
        logLines = []
        lastSeq = 0
        logError = nil
    }

    /// Trae sólo lo nuevo (`after`) y guarda las últimas 500.
    func pollLogs() {
        guard !isFixture else { return }
        let server = selected, level = logLevel, after = lastSeq
        Task { @MainActor in
            do {
                let page = try await RunnerClient(server: server).logs(after: after, level: level)
                guard server == selected, level == logLevel, after == lastSeq else { return }
                lastSeq = page.last_seq
                logLines = Array((logLines + page.lines).suffix(500))
                logError = nil
            } catch let e as RunnerError {
                logError = e.status == 404 || e.status == 501 ? "Este runner todavía no expone /api/logs (actualízalo)." : e.message
            } catch {
                logError = error.localizedDescription
            }
        }
    }

    func copyLogs() {
        let text = logLines.map { "\($0.time) \($0.level.uppercased()) [\($0.scope)] \($0.message) \($0.fields ?? "")" }.joined(separator: "\n")
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        toast?("Log copiado")
    }
}

extension RunnerModel {
    /// Datos de ejemplo para las capturas: no llama a ningún server.
    static func fixture() -> RunnerModel {
        let epic = TaskEpic(ref: "la-haus/subscriptions#4200", title: "feat(360): funnel configurable por empresa — etapas personalizadas", done: 19, total: 24)
        func item(_ n: Int, _ title: String, group: String, kind: String, why: String, actions: [String],
                  epic: TaskEpic? = nil, priority: Int? = nil, said: String? = nil, pr: Int? = nil, agent: String? = nil) -> InboxItem {
            InboxItem(ref: "la-haus/subscriptions#\(n)", project_id: "p", title: title, url: "https://github.com", group: group, kind: kind,
                      status: nil, why: why, since: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-Double(n % 50) * 900)), pr: pr.map { PullRef(number: $0, url: "https://github.com") },
                      execution: agent.map { ExecutionSummary(id: "x", pipeline_id: "build", status: "running", started_at: "", agent_id: $0) },
                      blocked_by: nil, epic: epic, agent_said: said, actions: actions, action_defs: nil, priority: priority, reasons: nil)
        }
        let inbox = Inbox(generated_at: "", projects: [], items: [
            item(4281, "feat(core): el motor de asignación resuelve assignable_stages y stage_weights", group: "need", kind: "review", why: "Review sin reviewed · PR #912",
                 actions: ["rerun_review", "retry"], epic: epic, priority: 1, pr: 912),
            item(4290, "fix(crm): evento lead.profiled en EventBridge", group: "need", kind: "doubt", why: "El agente se trabó y te pregunta",
                 actions: ["answer_and_unblock", "back_to_refine"], epic: epic, priority: 2, said: "¿El evento lleva el user_id o el lead_id?"),
            item(4301, "Migrar tabla de citas", group: "fail", kind: "crash", why: "La corrida falló por el provider (timeout)",
                 actions: ["retry"], priority: 3),
            InboxItem(ref: "la-haus/subscriptions#1271", project_id: "p", title: "Pipeline propio configurable: stages y transitions declarativas (reemplazo del if/elif)",
                      url: "", group: "need", kind: "prd", status: nil, why: "PRD listo para aprobar (status Refined)", since: "2026-10-13T10:00:00Z",
                      pr: nil, execution: nil, blocked_by: nil, epic: nil, agent_said: nil, actions: ["approve_prd", "back_to_refine"],
                      action_defs: [TaskActionDef(id: "approve_prd", label: "Aprobar y pasar a Build", comment: nil, confirm: "¿Aprobar el PRD?")],
                      priority: 4, reasons: nil),
            item(4295, "Pantalla de perfilado", group: "run", kind: "agent", why: "build corriendo hace 12 min",
                 actions: ["stop"], epic: epic, agent: "aiflow-implementer"),
            item(4310, "Copys del widget", group: "queue", kind: "turn", why: "Espera un lugar libre", actions: []),
        ], pipeline: InboxPipeline(running: 1, queued: 1, paused: 0, capacity: 3, free: 2), feed: nil)
        let model = RunnerModel(servers: [RunnerServer(baseUrl: "https://ia-flow.ss.lahaus.com", label: nil, token: "x")], inbox: inbox)
        model.logLines = [
            RunnerLogLine(seq: 1, time: "2026-10-15T12:00:01.000Z", level: "info", scope: "ia-flow-runner-v2", message: "webhook projects_v2_item → la-haus/subscriptions#4295", fields: nil, trace_id: nil),
            RunnerLogLine(seq: 2, time: "2026-10-15T12:00:02.000Z", level: "info", scope: "engine", message: "dispatch build", fields: "agent=aiflow-implementer task=#4295", trace_id: nil),
            RunnerLogLine(seq: 3, time: "2026-10-15T12:00:09.000Z", level: "warn", scope: "github", message: "rate limit bajo: 312 restantes", fields: nil, trace_id: nil),
            RunnerLogLine(seq: 4, time: "2026-10-15T12:01:40.000Z", level: "error", scope: "provider", message: "timeout esperando al modelo", fields: "task=#4301", trace_id: nil),
        ]
        return model
    }
}
