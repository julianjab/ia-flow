import Foundation

// El cliente HTTP de la API del runner (la misma que usa la web: `packages/shared/src/inbox.ts` es el contrato).
// Sólo lo que muestra el menú: la bandeja, el log del proceso, las acciones sobre una tarea y el device flow de
// GitHub. Sin estado de interfaz; lo usa RunnerModel.swift.

// MARK: servidores

struct RunnerServer: Codable, Hashable {
    let baseUrl: String
    var label: String?
    var token: String?

    var name: String {
        if let label, !label.isEmpty { return label }
        return baseUrl.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "")
    }
}

private struct StoredServers: Codable { let servers: [RunnerServer] }

/// La lista de la app de escritorio (lo que la web guarda al agregar un server, con su token). Un
/// `runners.json` en la carpeta del menú la reemplaza, con la misma forma: `{"servers": [{baseUrl, label, token}]}`.
let desktopServersPath = "\(home)/Library/Application Support/IA Flow/servers.json"
var runnersPath: String { "\(configDir)/runners.json" }

func loadRunnerServers() -> [RunnerServer] {
    for path in [runnersPath, desktopServersPath] {
        guard let data = FileManager.default.contents(atPath: path) else { continue }
        guard let list = try? JSONDecoder().decode(StoredServers.self, from: data) else {
            FileHandle.standardError.write(Data("[menubar] \(path) no tiene la forma {servers: [...]}\n".utf8))
            continue
        }
        let servers = list.servers.filter { !$0.baseUrl.trimmingCharacters(in: .whitespaces).isEmpty }
        if !servers.isEmpty { return servers }
    }
    return [RunnerServer(baseUrl: "http://localhost:3001", label: "Local", token: nil)]
}

// MARK: sesión de GitHub (por server, como la web)

struct GithubSession: Codable {
    var token: String
    var login: String
    /// Segundos desde 1970.
    var expiresAt: Double?
    var refreshToken: String?

    var expired: Bool { expiresAt.map { Date().timeIntervalSince1970 > $0 - 60 } ?? false }
}

var githubSessionsPath: String { "\(configDir)/github-sessions.json" }

func loadGithubSessions() -> [String: GithubSession] {
    guard let data = FileManager.default.contents(atPath: githubSessionsPath) else { return [:] }
    return (try? JSONDecoder().decode([String: GithubSession].self, from: data)) ?? [:]
}

/// Sólo legible por el usuario: lleva tokens de GitHub.
func saveGithubSessions(_ sessions: [String: GithubSession]) {
    try? FileManager.default.createDirectory(atPath: configDir, withIntermediateDirectories: true)
    guard let data = try? JSONEncoder().encode(sessions) else { return }
    FileManager.default.createFile(atPath: githubSessionsPath, contents: data, attributes: [.posixPermissions: 0o600])
}

// MARK: el contrato (lo que el menú lee de él)

struct TaskEpic: Codable, Hashable {
    let ref: String
    let title: String
    let done: Int
    let total: Int
}

struct ExecutionSummary: Codable, Hashable {
    let id: String
    let pipeline_id: String
    let status: String
    let started_at: String
    let agent_id: String?
    var closed_at: String? = nil
    /// Lo que dijo el agente al cerrar (su resumen).
    var summary: String? = nil
    var failure: ExecutionFailure? = nil
    var usage: ExecutionUsage? = nil
    /// Cada agente de la ejecución (ExecutionAgents.swift): en una viva, siempre; en una cerrada, sólo si corrió más
    /// de uno y es la primera del detalle. Un runner viejo no lo manda.
    var agents: [ExecutionAgent]? = nil
    /// El último paso de la ejecución viva, y hace cuánto (s).
    var last_step_at: String? = nil
    var idle_seconds: Double? = nil
}

struct TaskActionDef: Codable, Hashable {
    let id: String
    let label: String
    let comment: String?
    let confirm: String?
}

struct PullRef: Codable, Hashable {
    let number: Int
    let url: String
}

struct InboxItem: Codable, Identifiable, Hashable {
    let ref: String
    let project_id: String
    let title: String
    let url: String
    let group: String
    let kind: String
    let status: String?
    let why: String
    let since: String
    let pr: PullRef?
    let execution: ExecutionSummary?
    let blocked_by: [String]?
    let epic: TaskEpic?
    let agent_said: String?
    let actions: [String]
    let action_defs: [TaskActionDef]?
    let priority: Int?
    let reasons: [String]?

    var id: String { ref }
    /// `#123` (el repo va en la ayuda del botón).
    var shortRef: String { ref.split(separator: "#").last.map { "#\($0)" } ?? ref }
}

struct InboxPipeline: Codable, Hashable {
    let running: Int
    let queued: Int
    let paused: Int
    let capacity: Int?
    let free: Int?
}

/// Una card de Todo que todavía no arrancó (`feed.ready` y `feed.waiting` de la bandeja).
struct FeedItem: Codable, Hashable, Identifiable {
    let ref: String
    let title: String
    let url: String
    /// Los issues abiertos que la bloquean: sólo en `waiting`.
    let blocked_by: [String]?
    var project_id: String? = nil
    /// Su columna (la de Todo del board).
    var status: String? = nil
    var updated_at: String? = nil
    var id: String { ref }
}

/// Una card del board que no está en la bandeja (`GET /api/board`).
struct BoardItem: Codable, Hashable, Identifiable {
    let ref: String
    let title: String
    let url: String
    let status: String?
    let pr: PullRef?
    var id: String { ref }
}

private struct BoardRest: Codable {
    struct Column: Codable { let status: String; let items: [BoardItem] }
    let columns: [Column]
}

private struct TaskDetail: Codable { let item: InboxItem }

struct InboxFeed: Codable, Hashable {
    let ready: [FeedItem]
    let waiting: [FeedItem]
}

struct InboxProject: Codable, Hashable {
    let id: String
    let board_url: String?
    let url: String?
    /// Las columnas del board en su orden: a dónde se mueve o se agrega una card. Un runner viejo no las manda.
    var statuses: [String]? = nil
}

struct Inbox: Codable {
    let generated_at: String
    let projects: [InboxProject]
    let items: [InboxItem]
    let pipeline: InboxPipeline?
    let feed: InboxFeed?
}

struct RunnerLogLine: Codable, Identifiable, Hashable {
    let seq: Int
    let time: String
    let level: String
    let scope: String
    let message: String
    let fields: String?
    let trace_id: String?
    var id: Int { seq }
}

struct RunnerLogs: Codable {
    let lines: [RunnerLogLine]
    let last_seq: Int
    let capacity: Int
}

/// Una mejora que propuso un agente (la retrospectiva) y espera a una persona: abrirla como issue o descartarla.
struct Improvement: Codable, Identifiable, Hashable {
    let id: String
    let created_at: String
    /// La tarea de la que sale; nil en una de config o del engine propuesta desde el chat general.
    let task_ref: String?
    let pr_url: String?
    let agent: String
    /// `docs`, `config` o `engine`: dónde se arregla.
    let target: String
    /// `owner/repo` donde se abre el issue.
    let repo: String
    let title: String
    let body: String
    let reason: String
    let status: String
    /// La ejecución del agente que la propuso: la evidencia de por qué.
    var execution_id: String? = nil

    /// El nombre del repo de donde sale (el de su tarea; sin tarea, el del issue): lo que filtra el tag del buscador.
    var originRepo: String {
        task_ref.flatMap { RunnerSearch.split($0)?.repo } ?? (repo.split(separator: "/").last.map(String.init) ?? repo)
    }

    /// `#n` de su tarea (o `repo#n`), para la línea de la fila; nil sin tarea.
    var taskLabel: String? {
        task_ref.map { ref in ref.split(separator: "/").last.map(String.init) ?? ref }
    }
}

private struct ImprovementList: Codable { let items: [Improvement] }

/// Lo que contesta el runner a algo que se firma con tu login: `ok` y qué pasó (o por qué no).
protocol RunnerReply {
    var ok: Bool { get }
    var message: String { get }
}

struct TaskActionResult: Codable, RunnerReply {
    let ok: Bool
    let message: String
}

/// `POST /api/board/items`: la card agregada y en qué columna quedó.
struct AddToBoardResult: Codable, RunnerReply {
    let ok: Bool
    let message: String
    var ref: String? = nil
    var status: String? = nil
}

struct DeviceCode: Codable {
    let device_code: String
    let user_code: String
    let verification_uri: String
    let expires_in: Int
    let interval: Int
}

struct DevicePoll: Codable {
    let status: String
    let access_token: String?
    let login: String?
    let expires_in: Double?
    let refresh_token: String?
}

private struct ErrorBody: Codable {
    let error: String?
    let message: String?
}

// MARK: cliente

struct RunnerError: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
    /// 401/403 del token del runner (no de GitHub): falta o está mal en servers.json.
    var needsRunnerToken: Bool { status == 503 || (status == 401 && message.contains("token")) }
}

struct RunnerClient {
    let server: RunnerServer

    func request(_ path: String, method: String = "GET", body: Encodable? = nil, github: String? = nil) async throws -> Data {
        guard let url = URL(string: server.baseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")) + path) else {
            throw RunnerError(status: 0, message: "URL inválida: \(server.baseUrl)")
        }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.httpMethod = method
        if let token = server.token, !token.isEmpty { req.setValue(token, forHTTPHeaderField: "x-ia-flow-token") }
        if let github { req.setValue(github, forHTTPHeaderField: "x-github-token") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONEncoder().encode(body)
        }
        let data: Data, response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            throw RunnerError(status: 0, message: "No responde \(server.name): \(error.localizedDescription)")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let body = try? JSONDecoder().decode(ErrorBody.self, from: data)
            throw RunnerError(status: status, message: body?.error ?? body?.message ?? "HTTP \(status)")
        }
        return data
    }

    func get<T: Decodable>(_ path: String) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await request(path))
    }

    func inbox() async throws -> Inbox { try await get("/api/inbox") }

    func logs(after: Int, level: String?) async throws -> RunnerLogs {
        var path = "/api/logs?limit=500"
        if after > 0 { path += "&after=\(after)" }
        if let level { path += "&level=\(level)" }
        return try await get(path)
    }

    /// El runner contesta las rechazadas (409, 403…) con el mismo `{ok, message}`: el mensaje es lo que se muestra.
    func act(_ item: InboxItem, action: String, comment: String?, github: String) async throws -> TaskActionResult {
        try await act(ref: item.ref, action: action, comment: comment, github: github)
    }

    func act(ref: String, action: String, comment: String?, github: String) async throws -> TaskActionResult {
        struct Body: Encodable { let action: String; let comment: String? }
        let parts = ref.split(whereSeparator: { $0 == "/" || $0 == "#" }).map(String.init)
        guard parts.count == 3 else { throw RunnerError(status: 0, message: "ref inválida: \(ref)") }
        do {
            let data = try await request("/api/tasks/\(parts[0])/\(parts[1])/\(parts[2])/actions", method: "POST",
                                         body: Body(action: action, comment: comment), github: github)
            return try JSONDecoder().decode(TaskActionResult.self, from: data)
        } catch let error as RunnerError {
            return TaskActionResult(ok: false, message: error.message)
        }
    }

    /// Mueve la card a otra columna del board, con tu login. 409 si un agente la está trabajando o ya está ahí.
    func move(ref: String, to status: String, github: String) async -> TaskActionResult {
        struct Body: Encodable { let status: String }
        guard let parts = RunnerSearch.split(ref) else { return TaskActionResult(ok: false, message: "ref inválida: \(ref)") }
        do {
            let data = try await request("/api/tasks/\(parts.owner)/\(parts.repo)/\(parts.number)/status", method: "POST",
                                         body: Body(status: status), github: github)
            return try JSONDecoder().decode(TaskActionResult.self, from: data)
        } catch let error as RunnerError {
            return TaskActionResult(ok: false, message: error.message)
        } catch {
            return TaskActionResult(ok: false, message: error.localizedDescription)
        }
    }

    /// Agrega un issue al board (sin `status`, en Todo), con tu login. 409 si ya está o el repo no es del board; 400
    /// si es un PR; 404 si no existe.
    func addToBoard(issue: String, projectId: String?, status: String?, github: String) async -> AddToBoardResult {
        struct Body: Encodable { let issue: String; let project_id: String?; let status: String? }
        do {
            let data = try await request("/api/board/items", method: "POST",
                                         body: Body(issue: issue, project_id: projectId, status: status), github: github)
            return try JSONDecoder().decode(AddToBoardResult.self, from: data)
        } catch let error as RunnerError {
            return AddToBoardResult(ok: false, message: error.message)
        } catch {
            return AddToBoardResult(ok: false, message: error.localizedDescription)
        }
    }

    /// Pone y saca labels del issue de la card (`POST …/labels`), con tu login: p. ej. sacar `blocked` la destraba.
    func labels(ref: String, add: [String], remove: [String], github: String) async -> TaskActionResult {
        struct Body: Encodable { let add: [String]?; let remove: [String]? }
        guard let parts = RunnerSearch.split(ref) else { return TaskActionResult(ok: false, message: "ref inválida: \(ref)") }
        do {
            let data = try await request("/api/tasks/\(parts.owner)/\(parts.repo)/\(parts.number)/labels", method: "POST",
                                         body: Body(add: add.isEmpty ? nil : add, remove: remove.isEmpty ? nil : remove),
                                         github: github)
            return try JSONDecoder().decode(TaskActionResult.self, from: data)
        } catch let error as RunnerError {
            return TaskActionResult(ok: false, message: error.message)
        } catch {
            return TaskActionResult(ok: false, message: error.localizedDescription)
        }
    }

    /// Las cards que no están en la bandeja, de todas las columnas.
    func board() async throws -> [BoardItem] {
        let rest: BoardRest = try await get("/api/board")
        return rest.columns.flatMap(\.items)
    }

    /// Una tarea por su ref, esté o no en la bandeja (con sus acciones); nil si no está en ningún board.
    func task(_ ref: String) async throws -> InboxItem? {
        guard let parts = RunnerSearch.split(ref) else { return nil }
        do {
            let detail: TaskDetail = try await get("/api/tasks/\(parts.owner)/\(parts.repo)/\(parts.number)")
            return detail.item
        } catch let error as RunnerError where error.status == 404 {
            return nil
        }
    }

    /// Las abiertas. Un runner sin mejoras (501) o viejo (404) da una lista vacía.
    func improvements() async throws -> [Improvement] {
        do {
            let list: ImprovementList = try await get("/api/improvements?status=open")
            return list.items
        } catch let error as RunnerError where error.status == 501 || error.status == 404 {
            return []
        }
    }

    /// `open` abre el issue con el login de la persona; `dismiss` la descarta. Rechazos con `{ok, message}`.
    func decide(_ improvement: Improvement, open: Bool, github: String) async -> TaskActionResult {
        do {
            let data = try await request("/api/improvements/\(improvement.id)/\(open ? "open" : "dismiss")", method: "POST", github: github)
            return try JSONDecoder().decode(TaskActionResult.self, from: data)
        } catch let error as RunnerError {
            return TaskActionResult(ok: false, message: error.message)
        } catch {
            return TaskActionResult(ok: false, message: error.localizedDescription)
        }
    }

    func deviceStart() async throws -> DeviceCode {
        try JSONDecoder().decode(DeviceCode.self, from: try await request("/api/auth/github/device", method: "POST"))
    }

    func devicePoll(_ code: String) async throws -> DevicePoll {
        struct Body: Encodable { let device_code: String }
        return try JSONDecoder().decode(DevicePoll.self, from:
            try await request("/api/auth/github/device/poll", method: "POST", body: Body(device_code: code)))
    }

    func refresh(_ refreshToken: String) async throws -> DevicePoll {
        struct Body: Encodable { let refresh_token: String }
        return try JSONDecoder().decode(DevicePoll.self, from:
            try await request("/api/auth/github/refresh", method: "POST", body: Body(refresh_token: refreshToken)))
    }
}
