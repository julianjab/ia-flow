import Foundation

// El asistente del runner por HTTP (`POST /api/assistant` por SSE, las conversaciones guardadas y los issues que
// propone): el mismo contrato que usa la web (`packages/shared/src/inbox.ts`). Sin estado; lo usa AssistantModel.

/// De qué habla el asistente: todo el runner o una tarea.
enum AssistantScope: Equatable, Codable {
    case general
    case task(ref: String)

    private enum Keys: String, CodingKey { case kind, ref }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        // `project` (que el menú no usa) se lee como general: igual se puede retomar.
        if try c.decode(String.self, forKey: .kind) == "task", let ref = try c.decodeIfPresent(String.self, forKey: .ref) {
            self = .task(ref: ref)
        } else {
            self = .general
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .general: try c.encode("general", forKey: .kind)
        case .task(let ref): try c.encode("task", forKey: .kind); try c.encode(ref, forKey: .ref)
        }
    }

    var ref: String? { if case .task(let ref) = self { return ref } else { return nil } }
}

/// Lo que propone el asistente: una acción sobre una tarea (`ref` + `action`) o abrir un issue (`kind: issue`).
struct AssistantProposal: Codable, Hashable, Identifiable {
    let id: String
    let kind: String?
    let label: String
    let reason: String
    // acción sobre una tarea
    let ref: String?
    let action: String?
    let comment: String?
    // issue nuevo
    let repo: String?
    let title: String?
    let body: String?
    let labels: [String]?

    var isIssue: Bool { kind == "issue" }
}

/// Un evento del stream: `text`, `tool`, `proposal`, `tasks`, `conversation`, `done` o `error`.
struct AssistantEvent: Decodable {
    let type: String
    let delta: String?
    let name: String?
    let summary: String?
    let proposal: AssistantProposal?
    let items: [InboxItem]?
    let id: String?
    let text: String?
    let message: String?
}

struct AssistantConversationSummary: Codable, Identifiable, Hashable {
    let id: String
    let scope: AssistantScope
    let title: String
    let updated_at: String
    let messages: Int

    static func == (a: Self, b: Self) -> Bool { a.id == b.id && a.updated_at == b.updated_at }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

struct AssistantStoredMessage: Codable {
    let role: String
    let content: String
    let proposals: [AssistantProposal]
    let tasks: [InboxItem]
}

struct AssistantConversation: Codable {
    let id: String
    let scope: AssistantScope
    let thread: [AssistantStoredMessage]
}

struct RunnerInfo: Codable {
    struct Agent: Codable, Hashable { let id: String; let label: String }
    let version: String
    let assistant: Bool
    var assistant_agents: [Agent]? = nil
}

struct CreateIssueResult: Codable {
    let ok: Bool
    let message: String
    let url: String?
}

private struct AssistantRequest: Encodable {
    struct Message: Encodable { let role: String; let content: String }
    let scope: AssistantScope
    let messages: [Message]
    let conversation_id: String?
}

extension RunnerClient {
    func info() async throws -> RunnerInfo { try await get("/api/runner") }

    /// Manda la conversación entera (el runner no guarda el hilo del modelo, sólo el registro) y entrega cada
    /// evento del stream. Con `github`, el intercambio queda guardado a nombre de ese login.
    func ask(scope: AssistantScope, messages: [(role: String, content: String)], conversationId: String?, github: String?,
             onEvent: @escaping (AssistantEvent) -> Void) async throws {
        guard let url = URL(string: server.baseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")) + "/api/assistant") else {
            throw RunnerError(status: 0, message: "URL inválida: \(server.baseUrl)")
        }
        var req = URLRequest(url: url, timeoutInterval: 600)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue("text/event-stream", forHTTPHeaderField: "accept")
        if let token = server.token, !token.isEmpty { req.setValue(token, forHTTPHeaderField: "x-ia-flow-token") }
        if let github { req.setValue(github, forHTTPHeaderField: "x-github-token") }
        req.httpBody = try JSONEncoder().encode(AssistantRequest(
            scope: scope, messages: messages.map { .init(role: $0.role, content: $0.content) },
            conversation_id: github == nil ? nil : conversationId))

        let (bytes, response) = try await URLSession.shared.bytes(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            var raw = Data()
            for try await byte in bytes { raw.append(byte) }
            struct Body: Decodable { let error: String?; let message: String? }
            let body = try? JSONDecoder().decode(Body.self, from: raw)
            throw RunnerError(status: status, message: body?.error ?? body?.message ?? "HTTP \(status)")
        }
        // Una línea `data:` por evento; los comentarios (`: ping`) y las líneas en blanco no traen nada.
        for try await line in bytes.lines {
            try Task.checkCancellation()
            guard line.hasPrefix("data:") else { continue }
            let json = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            if let event = try? JSONDecoder().decode(AssistantEvent.self, from: Data(json.utf8)) { onEvent(event) }
        }
    }

    func conversations(scope: AssistantScope, github: String) async throws -> [AssistantConversationSummary] {
        let json = String(data: try JSONEncoder().encode(scope), encoding: .utf8) ?? "{}"
        let query = json.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        return try JSONDecoder().decode([AssistantConversationSummary].self,
                                        from: try await request("/api/assistant/conversations?scope=\(query)", github: github))
    }

    func conversation(_ id: String, github: String) async throws -> AssistantConversation {
        try JSONDecoder().decode(AssistantConversation.self, from: try await request("/api/assistant/conversations/\(id)", github: github))
    }

    func createIssue(_ proposal: AssistantProposal, github: String) async -> CreateIssueResult {
        struct Body: Encodable { let repo: String; let title: String; let body: String; let labels: [String]? }
        do {
            let data = try await request("/api/issues", method: "POST", body: Body(repo: proposal.repo ?? "", title: proposal.title ?? "",
                                                                                    body: proposal.body ?? "", labels: proposal.labels),
                                         github: github)
            return try JSONDecoder().decode(CreateIssueResult.self, from: data)
        } catch let error as RunnerError {
            return CreateIssueResult(ok: false, message: error.message, url: nil)
        } catch {
            return CreateIssueResult(ok: false, message: error.localizedDescription, url: nil)
        }
    }
}
