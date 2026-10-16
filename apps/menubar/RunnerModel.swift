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
    enum Screen { case inbox, logs, run, health, github, improvements, improvement }

    @Published private(set) var servers: [RunnerServer]
    @Published private(set) var selected: RunnerServer
    @Published private(set) var inbox: Inbox?
    /// Las mejoras propuestas abiertas del server.
    @Published fileprivate(set) var improvements: [Improvement] = []
    @Published private(set) var error: RunnerError?
    @Published private(set) var loading = false
    @Published var screen: Screen = .inbox
    /// El estado del server (la pantalla «Estado del runner»).
    @Published var health: RunnerHealth?
    private var checkingHealth = false
    /// La ejecución que se mira en «En vivo».
    @Published private(set) var watching: RunWatch?
    @Published var comment: CommentRequest?
    @Published var login: DeviceLogin?
    /// Las refs con una acción en vuelo: su botón no se puede volver a tocar.
    @Published private(set) var busy: Set<String> = []

    /// Lo que se escribe en el buscador: filtra todas las secciones y busca en el resto del board.
    @Published var query = "" { didSet { if query != oldValue { searchChanged() } } }
    /// Las cards del board fuera de la bandeja que coinciden.
    @Published private(set) var boardResults: [BoardItem] = []
    /// Las tareas buscadas fuera de la bandeja, ya con sus acciones (las primeras del board, o la ref exacta).
    @Published private(set) var lookups: [InboxItem] = []
    @Published private(set) var searching = false
    /// La ref exacta que se buscó y no está en ningún board del runner.
    @Published private(set) var lookupMiss: String?
    /// El stream del runner (SSE) está conectado: la bandeja se relee cuando algo cambia, no cada 6 s.
    @Published private(set) var live = false
    private let stream = RunnerStream()
    private var pendingRefresh: DispatchWorkItem?
    private var pendingTrace: DispatchWorkItem?
    /// La mejora sobre la que se pregunta por qué (la pantalla «¿Por qué?») y su chat con el asistente.
    @Published private(set) var discussing: Improvement?
    @Published private(set) var improvementChat: AssistantModel?
    /// La pantalla «GitHub» (buscar en cualquier repo de la organización); se crea al abrirla y se conserva.
    @Published private(set) var githubSearch: GithubSearchModel?
    private var boardCache: (items: [BoardItem], at: Date)?
    private var searchTask: Task<Void, Never>?

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
    /// «Preguntar sobre esta tarea» (lo resuelve la app: cambia a la pestaña Asistente).
    var onAsk: ((InboxItem) -> Void)?
    var confirm: ((ConfirmRequest) -> Void)?
    let isFixture: Bool

    init(servers: [RunnerServer]? = nil, inbox: Inbox? = nil) {
        isFixture = servers != nil
        let list = servers ?? loadRunnerServers()
        self.servers = list
        let saved = UserDefaults.standard.string(forKey: "runnerServer")
        selected = list.first { $0.baseUrl == saved } ?? list[0]
        self.inbox = inbox
        restoreRepoFilter()
    }

    private var client: RunnerClient { RunnerClient(server: selected) }

    /// Al arrancar, el repo que se había elegido para este server.
    func restoreRepoFilter() {
        guard !isFixture else { return }
        repoFilter = UserDefaults.standard.string(forKey: "runnerRepo:\(selected.baseUrl)")
    }

    // MARK: lo que se muestra

    var decisions: [InboxItem] {
        (inbox?.items ?? []).filter(\.isDecision).sorted { ($0.priority ?? .max) < ($1.priority ?? .max) }
    }
    var running: [InboxItem] { (inbox?.items ?? []).filter { $0.group == "run" } }
    var queued: [InboxItem] { (inbox?.items ?? []).filter { $0.group == "queue" } }
    /// El badge: lo que te espera a vos (decisiones y mejoras por decidir).
    var pendingCount: Int { decisions.count + improvements.count }

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

    // MARK: buscador

    /// `subscriptions` de `la-haus/subscriptions#12`.
    func repoName(_ ref: String) -> String? { RunnerSearch.split(ref)?.repo }

    var search: RunnerSearch? { RunnerSearch(query) }

    /// El repo elegido en el tag del buscador (sólo el nombre, `subscriptions`); nil = todos.
    @Published var repoFilter: String? {
        didSet {
            guard repoFilter != oldValue else { return }
            if !isFixture { UserDefaults.standard.set(repoFilter, forKey: "runnerRepo:\(selected.baseUrl)") }
            searchChanged()
        }
    }

    /// Buscando o con un repo elegido: las secciones muestran sólo lo que coincide.
    var filtering: Bool { search != nil || repoFilter != nil }

    /// Los repos que se conocen (bandeja, board y mejoras), con cuántas tareas tiene cada uno en la bandeja.
    var repos: [(name: String, count: Int)] {
        let inboxRepos = (inbox?.items ?? []).compactMap { repoName($0.ref) }
        var names = Set(inboxRepos)
        names.formUnion((boardCache?.items ?? []).compactMap { repoName($0.ref) })
        if let repoFilter { names.insert(repoFilter) }
        return names.sorted().map { name in (name, inboxRepos.filter { $0 == name }.count) }
    }

    func inRepo(_ ref: String) -> Bool { repoFilter.map { repoName(ref) == $0 } ?? true }

    /// Coincide la tarea, o su épica (buscar una épica trae sus tareas); y está en el repo elegido.
    func keep(_ item: InboxItem) -> Bool {
        guard inRepo(item.ref) else { return false }
        guard let search else { return true }
        return search.matches(ref: item.ref, title: item.title, pr: item.pr?.number)
            || item.epic.map { search.matches(ref: $0.ref, title: $0.title) } == true
    }

    var shownDecisions: [InboxItem] { decisions.filter(keep) }
    var shownRunning: [InboxItem] { running.filter(keep) }
    var shownQueued: [InboxItem] { queued.filter(keep) }
    var shownImprovements: [Improvement] {
        improvements.filter { inRepo($0.task_ref) && (search?.matches(ref: $0.task_ref, title: $0.title) ?? true) }
    }
    /// Una épica se muestra si la buscada es ella (su número) o alguna de sus tareas; con un repo, si tiene tareas ahí.
    var shownEpics: [EpicView] {
        guard filtering else { return epics }
        return epics.filter { epic in
            epic.items.contains(where: keep)
                || (repoFilter == nil && search?.matches(ref: epic.epic.ref, title: epic.epic.title) == true)
        }
    }
    var resultCount: Int {
        shownDecisions.count + shownRunning.count + shownQueued.count + shownImprovements.count + shownEpics.count + lookups.count
            + shownFeed.ready.count + shownFeed.waiting.count
            + boardResults.filter { b in !lookups.contains { $0.ref == b.ref } }.count
    }

    func clearSearch() { query = "" }

    /// Espera a que se deje de escribir y busca afuera de la bandeja: el board (cacheado 1 min) y el detalle de las
    /// primeras coincidencias, que es lo que trae sus acciones.
    private func searchChanged() {
        searchTask?.cancel()
        guard let search, !isFixture else {
            boardResults = []; lookups = []; lookupMiss = nil; searching = false
            return
        }
        let server = selected
        searchTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            searching = true
            defer { if !Task.isCancelled { searching = false } }
            let client = RunnerClient(server: server)
            if boardCache == nil || Date().timeIntervalSince(boardCache!.at) > 60 {
                if let items = try? await client.board() { boardCache = (items, Date()) }
            }
            guard !Task.isCancelled, server == selected else { return }
            let inBox = Set((inbox?.items ?? []).map(\.ref))
            let board = (boardCache?.items ?? []).filter {
                !inBox.contains($0.ref) && inRepo($0.ref) && search.matches(ref: $0.ref, title: $0.title, pr: $0.pr?.number)
            }
            var wanted = board.prefix(3).map(\.ref)
            // La ref exacta (o `repo#n` con un owner conocido) que no aparece en ningún lado: se pide igual.
            let exact = search.fullRef ?? search.number.flatMap { n in
                search.repo.flatMap { repo in (ownerOf(repo: repo) ?? organization).map { "\($0)/\(repo)#\(n)" } }
            }
            if let exact, !inBox.contains(exact), !board.contains(where: { $0.ref == exact }) { wanted.append(exact) }
            var found: [InboxItem] = []
            var miss: String?
            for ref in wanted {
                if let item = try? await client.task(ref) { found.append(item) } else if ref == exact { miss = ref }
            }
            guard !Task.isCancelled, server == selected else { return }
            boardResults = board
            lookups = found
            lookupMiss = miss
        }
    }

    /// Lo que se sabe que está en el board (la bandeja, Todo y `/api/board`), con su columna si se conoce. En
    /// minúsculas: GitHub y el runner pueden escribir distinto el owner.
    var boardStatuses: [String: String] {
        var known: [String: String] = [:]
        for item in boardCache?.items ?? [] { known[item.ref.lowercased()] = item.status ?? "" }
        for item in (inbox?.feed?.ready ?? []) + (inbox?.feed?.waiting ?? []) { known[item.ref.lowercased()] = item.status ?? "" }
        for item in inbox?.items ?? [] { known[item.ref.lowercased()] = item.status ?? "" }
        return known
    }

    /// Trae `/api/board` si no está o tiene más de un minuto (para saber qué ya está en el board).
    func warmBoard() {
        guard !isFixture, boardCache == nil || Date().timeIntervalSince(boardCache!.at) > 60 else { return }
        let server = selected
        Task { @MainActor in
            guard let items = try? await RunnerClient(server: server).board(), server == selected else { return }
            boardCache = (items, Date())
            objectWillChange.send()
        }
    }

    /// Algo cambió el board desde acá: la próxima consulta lo vuelve a traer.
    func forgetBoard() { boardCache = nil }

    /// La organización del runner: el owner de sus tareas.
    var organization: String? {
        let refs = (inbox?.items ?? []).map(\.ref) + (boardCache?.items ?? []).map(\.ref)
        return refs.lazy.compactMap(RunnerSearch.split).first?.owner
    }

    /// Abre la pantalla «GitHub», con lo que se estaba buscando (y el repo del tag) si se viene de la bandeja.
    func showGithub(query: String? = nil, repo: String? = nil) {
        let org = organization ?? UserDefaults.standard.string(forKey: "githubOrg") ?? "la-haus"
        if !isFixture, organization != nil { UserDefaults.standard.set(org, forKey: "githubOrg") }
        let model = githubSearch?.org == org ? githubSearch! : (isFixture ? GithubSearchModel.fixture(runner: self)
                                                                         : GithubSearchModel(org: org, runner: self))
        githubSearch = model
        if let repo { model.repo = repo }
        if let query { model.query = query }
        screen = .github
    }

    /// El owner de un repo según las refs que ya se conocen (la bandeja y el board).
    private func ownerOf(repo: String) -> String? {
        let refs = (inbox?.items ?? []).map(\.ref) + (boardCache?.items ?? []).map(\.ref)
        return refs.lazy.compactMap(RunnerSearch.split).first { $0.repo.lowercased() == repo.lowercased() }?.owner
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
        improvements = []
        boardCache = nil
        query = ""
        repoFilter = UserDefaults.standard.string(forKey: "runnerRepo:\(server.baseUrl)")
        error = nil
        login = nil
        comment = nil
        discussing = nil
        improvementChat = nil
        if screen == .improvement { screen = .improvements }
        resetLogs()
        refresh()
        // El stream es de un server: si estaba abierto, se reabre contra el nuevo.
        if stream.server != nil { startStream() }
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
                let client = RunnerClient(server: server)
                async let freshInbox = client.inbox()
                async let freshImprovements = client.improvements()
                let (fresh, proposals) = try await (freshInbox, freshImprovements)
                guard server == selected else { return }
                inbox = fresh
                improvements = proposals
                // La de «¿Por qué?», como quedó: el asistente la puede haber ajustado.
                if let current = discussing, let fresh = proposals.first(where: { $0.id == current.id }) { discussing = fresh }
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
    /// Abre Claude Code en un worktree de la tarea, en una pestaña de iTerm: `claude --worktree owner/repo/pr-N` (o `issue-N` sin PR).
    /// No va la URL: Claude Code rechaza `:` y `#` en el nombre y una URL de PR la toma como PR del repo del cwd. El
    /// hook global `WorktreeCreate` resuelve `owner/repo/…` al clone local y a la branch del PR o del issue.
    func openWorktree(_ item: InboxItem) {
        guard let ref = RunnerSearch.split(item.ref) else { return }
        let name = "\(ref.owner)/\(ref.repo)/" + (item.pr.map { "pr-\($0.number)" } ?? "issue-\(ref.number)")
        let command = "claude --worktree \(name)"
        // Desde ~/development (donde el hook busca los clones), y al salir de Claude queda el shell: se ve si falló.
        if !runInITerm("/bin/zsh -lc 'cd ~/development && \(command); exec /bin/zsh -l'", tab: true) {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(command, forType: .string)
            toast?("Sin iTerm: el comando quedó copiado")
        }
    }

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

    /// Una llamada firmada con tu login de GitHub: sin sesión la pide (`what`: para qué); mientras vuela, `key` queda
    /// ocupada; el resultado sale en un toast (`okPrefix` delante si salió) y la bandeja se relee.
    @MainActor @discardableResult
    func signed<R: RunnerReply>(_ key: String, what: String, okPrefix: String? = nil,
                                _ call: (RunnerClient, String) async -> R) async -> R? {
        let server = selected
        guard let session = await validSession() else {
            toast?("Inicia sesión con GitHub para \(what)")
            beginLogin()
            return nil
        }
        busy.insert(key)
        let result = await call(RunnerClient(server: server), session.token)
        busy.remove(key)
        toast?(result.ok ? [okPrefix, result.message].compactMap { $0 }.joined(separator: ": ") : "No se pudo: \(result.message)")
        refresh()
        return result
    }

    // MARK: mejoras

    /// Abrir crea un issue en otro repo con tu login: se confirma. Descartar no se deshace: también.
    func decide(_ improvement: Improvement, open: Bool) {
        confirm?(ConfirmRequest(
            title: open ? "¿Abrir el issue en \(improvement.repo)?" : "¿Descartar la mejora?",
            detail: "\(improvement.title)\n\n" + (open ? "Se abre con tu login de GitHub\(github.map { " (\($0.login))" } ?? "")."
                                                   : "Deja de proponerse; no se abre nada."),
            confirmLabel: open ? "Abrir issue" : "Descartar", destructive: !open
        ) { [weak self] in self?.sendDecision(improvement, open: open) })
    }

    private func sendDecision(_ improvement: Improvement, open: Bool) {
        let server = selected
        Task { @MainActor in
            guard let session = await validSession() else {
                toast?("Inicia sesión con GitHub para decidir la mejora")
                return beginLogin()
            }
            busy.insert(improvement.id)
            let result = await RunnerClient(server: server).decide(improvement, open: open, github: session.token)
            busy.remove(improvement.id)
            toast?(result.ok ? result.message : "No se pudo: \(result.message)")
            if result.ok {
                improvements.removeAll { $0.id == improvement.id }
                onBadge?(pendingCount)
                if discussing?.id == improvement.id, screen == .improvement { screen = .improvements }
            }
            refresh()
        }
    }

    // MARK: mejoras propuestas

    func showImprovements() { screen = .improvements }

    /// «¿Por qué?»: un chat con el asistente sobre la tarea de la mejora, con la mejora como contexto. La misma
    /// mejora retoma su chat; otra empieza uno nuevo.
    func discuss(_ improvement: Improvement) {
        if discussing?.id != improvement.id || improvementChat == nil {
            let chat: AssistantModel
            if isFixture { chat = AssistantModel.fixture(runner: self, improvement: improvement) } else {
                chat = AssistantModel(runner: self)
                chat.appear()
                chat.discuss(improvement)
            }
            chat.showTask = { [weak self] ref in self?.openTask(ref) }
            improvementChat = chat
            discussing = improvement
        }
        screen = .improvement
    }

    func openTask(_ ref: String) { NSWorkspace.shared.open(githubURL(ref)) }

    // MARK: login de GitHub (device flow, por server)

    /// La sesión del server, renovada si venció; sin sesión o sin poder renovarla, nil.
    @MainActor func validSession() async -> GithubSession? {
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

    // MARK: en vivo (SSE)

    /// Con el popover o la ventana abiertos: escuchar `/api/stream` del server elegido.
    func startStream() {
        guard !isFixture else { return }
        stream.onState = { [weak self] state in self?.live = state == .live }
        stream.onEvent = { [weak self] event in self?.handle(event) }
        stream.start(selected)
    }

    /// Con todo cerrado: en reposo no queda ninguna conexión abierta.
    func stopStream() {
        stream.stop()
        live = false
    }

    private func handle(_ event: RunnerStreamEvent) {
        switch event.type {
        case "inbox", "improvements": refreshSoon()
        case "trace":
            // Sólo si «En vivo» mira esa ejecución (o la última de la tarea, que es la que corre).
            guard let watch = watching, let id = event.entry?.execution_id,
                  watch.execution == nil || watch.execution?.id == id else { return }
            pendingTrace?.cancel()
            let work = DispatchWorkItem { [weak watch] in watch?.poll() }
            pendingTrace = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7, execute: work)
        default: break
        }
    }

    /// Varios cambios seguidos (un webhook mueve varias cosas) son una sola relectura; si hay una en vuelo, se
    /// espera a que termine para no perder el cambio.
    private func refreshSoon() {
        pendingRefresh?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if self.loading { self.refreshSoon() } else { self.refresh() }
        }
        pendingRefresh = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: work)
    }

    // MARK: estado del runner

    func showHealth() {
        if health?.info == nil || health.map({ Date().timeIntervalSince($0.checkedAt) > 10 }) == true { health = nil }
        screen = .health
        checkHealth()
    }

    func checkHealth() {
        guard !isFixture, !checkingHealth else { return }
        checkingHealth = true
        let server = selected
        Task { @MainActor in
            let fresh = await RunnerClient(server: server).health()
            checkingHealth = false
            guard server == selected else { return }
            health = fresh
        }
    }

    // MARK: en vivo

    /// Abre la traza de la tarea: lo que hace el agente ahora, o su última ejecución.
    func watch(_ item: InboxItem) {
        let next = isFixture ? RunWatch.fixture(item: item, server: selected) : RunWatch(item: item, server: selected)
        watching = next
        screen = .run
        next.poll()
    }

    func closeRun() {
        screen = .inbox
        watching = nil
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
                  epic: TaskEpic? = nil, priority: Int? = nil, said: String? = nil, pr: Int? = nil, agent: String? = nil,
                  repo: String = "subscriptions") -> InboxItem {
            InboxItem(ref: "la-haus/\(repo)#\(n)", project_id: "p", title: title, url: "https://github.com", group: group, kind: kind,
                      status: nil, why: why, since: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-Double(n % 50) * 900)), pr: pr.map { PullRef(number: $0, url: "https://github.com") },
                      execution: agent.map { ExecutionSummary(id: "x", pipeline_id: "build", status: "running", started_at: "", agent_id: $0) },
                      blocked_by: nil, epic: epic, agent_said: said, actions: actions, action_defs: nil, priority: priority, reasons: nil)
        }
        func card(_ n: Int, _ title: String, blocked: [String]? = nil, repo: String = "subscriptions") -> FeedItem {
            FeedItem(ref: "la-haus/\(repo)#\(n)", title: title, url: "https://github.com", blocked_by: blocked, project_id: "p", status: "Todo")
        }
        let feed = InboxFeed(ready: [
            card(4320, "feat(crm): exportar leads del funnel a CSV"),
            card(4322, "fix(widget): el teléfono no valida el indicativo", repo: "lh-seller-v2-frontend"),
        ], waiting: [
            card(4325, "feat(360): timeline usa la etapa del funnel", blocked: ["la-haus/subscriptions#4281"]),
        ])
        let project = InboxProject(id: "p", board_url: nil, url: nil, statuses: ["Todo", "Refine", "Refined", "Build", "Review", "Done"])
        let inbox = Inbox(generated_at: "", projects: [project], items: [
            item(4281, "feat(core): el motor de asignación resuelve assignable_stages y stage_weights", group: "need", kind: "review", why: "Review sin reviewed · PR #912",
                 actions: ["rerun_review", "retry"], epic: epic, priority: 1, pr: 912),
            item(4290, "fix(crm): evento lead.profiled en EventBridge", group: "need", kind: "doubt", why: "El agente se trabó y te pregunta",
                 actions: ["answer_and_unblock", "back_to_refine"], epic: epic, priority: 2, said: "¿El evento lleva el user_id o el lead_id?",
                 repo: "ai-cx-agents"),
            item(4301, "Migrar tabla de citas", group: "fail", kind: "crash", why: "La corrida falló por el provider (timeout)",
                 actions: ["retry"], priority: 3),
            InboxItem(ref: "la-haus/subscriptions#1271", project_id: "p", title: "Pipeline propio configurable: stages y transitions declarativas (reemplazo del if/elif)",
                      url: "", group: "need", kind: "prd", status: nil, why: "PRD listo para aprobar (status Refined)", since: "2026-10-13T10:00:00Z",
                      pr: nil, execution: nil, blocked_by: nil, epic: nil, agent_said: nil, actions: ["approve_prd", "back_to_refine"],
                      action_defs: [TaskActionDef(id: "approve_prd", label: "Aprobar y pasar a Build", comment: nil, confirm: "¿Aprobar el PRD?")],
                      priority: 4, reasons: nil),
            item(4295, "Pantalla de perfilado", group: "run", kind: "agent", why: "build corriendo hace 12 min",
                 actions: ["stop"], epic: epic, agent: "aiflow-implementer", repo: "lh-seller-v2-frontend"),
            item(4310, "Copys del widget", group: "queue", kind: "turn", why: "Espera un lugar libre", actions: []),
        ], pipeline: InboxPipeline(running: 1, queued: 1, paused: 0, capacity: 3, free: 2), feed: feed)
        let model = RunnerModel(servers: [RunnerServer(baseUrl: "https://ia-flow.ss.lahaus.com", label: nil, token: "x")], inbox: inbox)
        model.improvements = [
            Improvement(id: "1", created_at: "2026-10-15T09:00:00Z", task_ref: "la-haus/subscriptions#4281", pr_url: "https://github.com",
                        agent: "retrospective", target: "docs", repo: "la-haus/subscriptions",
                        title: "AGENTS.md: documentar cómo correr los tests de integración del CRM",
                        body: "…", reason: "El implementer tardó 3 vueltas en encontrar el comando de tests de integración.", status: "open"),
            Improvement(id: "2", created_at: "2026-10-15T08:00:00Z", task_ref: "la-haus/subscriptions#4290", pr_url: nil,
                        agent: "retrospective", target: "config", repo: "la-haus/claw-agents",
                        title: "Refiner: pedir el contrato del evento antes de cerrar el PRD",
                        body: "…", reason: "El PRD no decía qué id lleva el evento y el build se bloqueó por eso.", status: "open"),
        ]
        model.logLines = [
            RunnerLogLine(seq: 1, time: "2026-10-15T12:00:01.000Z", level: "info", scope: "ia-flow-runner-v2", message: "webhook projects_v2_item → la-haus/subscriptions#4295", fields: nil, trace_id: nil),
            RunnerLogLine(seq: 2, time: "2026-10-15T12:00:02.000Z", level: "info", scope: "engine", message: "dispatch build", fields: "agent=aiflow-implementer task=#4295", trace_id: nil),
            RunnerLogLine(seq: 3, time: "2026-10-15T12:00:09.000Z", level: "warn", scope: "github", message: "rate limit bajo: 312 restantes", fields: nil, trace_id: nil),
            RunnerLogLine(seq: 4, time: "2026-10-15T12:01:40.000Z", level: "error", scope: "provider", message: "timeout esperando al modelo", fields: "task=#4301", trace_id: nil),
        ]
        return model
    }
}
