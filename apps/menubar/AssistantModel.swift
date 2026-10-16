import AppKit
import SwiftUI

// El estado de la pestaña «Asistente»: de qué se habla (todo el runner o una tarea), los turnos, el stream en curso
// y las conversaciones guardadas. Vive con la app, no con el popover: si el popover se cierra a mitad de una
// respuesta, la respuesta sigue llegando y está ahí al volver.

struct ChatTurn: Identifiable {
    enum Role { case user, assistant, note }

    let id = UUID()
    let role: Role
    var text: String
    /// Lo que está haciendo el asistente ahora (la última tool), mientras responde.
    var activity: String?
    var streaming = false
    var proposals: [AssistantProposal] = []
    var tasks: [InboxItem] = []
}

final class AssistantModel: ObservableObject {
    @Published private(set) var scope: AssistantScope = .general
    /// El título de la tarea del scope, para el encabezado.
    @Published private(set) var scopeTitle: String?
    @Published private(set) var turns: [ChatTurn] = []
    @Published var input = ""
    @Published private(set) var streaming = false
    @Published private(set) var conversationId: String?
    @Published private(set) var history: [AssistantConversationSummary] = []
    /// nil = todavía no se sabe; false = el runner no tiene asistente.
    @Published private(set) var available: Bool?
    /// Las propuestas que ya se ejecutaron (o se están ejecutando) y cómo terminaron.
    @Published private(set) var proposalState: [String: String] = [:]
    /// Lo que viaja delante de la primera pregunta sin mostrarse (la mejora de «¿Por qué?»).
    private var preamble: String?

    unowned let runner: RunnerModel
    /// Abre una tarea que mencionó el asistente en la pestaña Runner (la busca por su ref).
    var showTask: ((String) -> Void)?
    private var stream: Task<Void, Never>?
    private var checkedServer: String?

    init(runner: RunnerModel) { self.runner = runner }

    // MARK: scope y conversación

    /// Al abrir la pestaña: si el runner tiene asistente (una vez por server) y las conversaciones del scope.
    func appear() {
        guard !runner.isFixture else { return }
        if checkedServer != runner.selected.baseUrl {
            checkedServer = runner.selected.baseUrl
            available = nil
            reset()
            let server = runner.selected
            Task { @MainActor in
                available = (try? await RunnerClient(server: server).info())?.assistant
                    ?? false
            }
        }
        loadHistory()
    }

    /// «Preguntar sobre esta tarea»: otra conversación, con la tarea como scope.
    func ask(about item: InboxItem) {
        guard scope != .task(ref: item.ref) || preamble != nil else { return }
        reset()
        preamble = nil
        scope = .task(ref: item.ref)
        scopeTitle = item.displayTitle
        loadHistory()
    }

    /// «¿Por qué propuso esto?»: la tarea de la mejora como scope y la mejora delante de la primera pregunta. La
    /// tarea suele estar cerrada (la retrospectiva corre al mergear): el runner igual la lee, con sus ejecuciones.
    /// Una que no sale de una tarea (de config o del engine, desde el chat general) va al contexto general.
    func discuss(_ improvement: Improvement) {
        reset()
        scope = improvement.task_ref.map { .task(ref: $0) } ?? .general
        scopeTitle = improvement.title
        preamble = Self.preamble(for: improvement)
    }

    static func preamble(for improvement: Improvement) -> String {
        let body = improvement.body.count > 4000 ? String(improvement.body.prefix(4000)) + "… [recortado]" : improvement.body
        let origin = [improvement.pr_url.map { "PR \($0)" }, improvement.execution_id.map { "ejecución \($0)" }]
            .compactMap { $0 }.joined(separator: ", ")
        let about = improvement.task_ref.map { "sobre \($0)" } ?? "sin una tarea de origen"
        let evidence = improvement.task_ref == nil
            ? "No sale de una tarea: para contestar, apóyate en la config y en lo que sabés del runner."
            : "Para contestar, mira la ejecución del agente (get_task y get_trace) y apóyate en lo que muestra la traza."
        return """
        Pregunto por la mejora \(improvement.id), que propuso el agente «\(improvement.agent)» \(about)\(origin.isEmpty ? "" : " (\(origin))"). \
        Se abriría como issue en \(improvement.repo) (\(improvement.target)). Si te pido ajustarla, usá \
        assistant_revise_improvement con id \(improvement.id); si hace falta otra mejora, assistant_add_improvement \
        basada en \(improvement.id). No me pegues el issue en la respuesta: lo leo en la card.
        Título: \(improvement.title)
        Razón que dio: \(improvement.reason)
        Cuerpo propuesto:
        \(body)

        \(evidence)

        Mi pregunta:
        """
    }

    func toGeneral() {
        guard scope != .general else { return }
        reset()
        preamble = nil
        scope = .general
        scopeTitle = nil
        loadHistory()
    }

    /// Conversación nueva en el mismo scope.
    func reset() {
        stream?.cancel()
        stream = nil
        streaming = false
        turns = []
        conversationId = nil
        proposalState = [:]
    }

    func loadHistory() {
        let server = runner.selected, scope = scope
        Task { @MainActor in
            guard let session = await runner.validSession() else { history = []; return }
            let list = (try? await RunnerClient(server: server).conversations(scope: scope, github: session.token)) ?? []
            guard server == runner.selected, scope == self.scope else { return }
            history = list
        }
    }

    func resume(_ summary: AssistantConversationSummary) {
        let server = runner.selected
        Task { @MainActor in
            guard let session = await runner.validSession(),
                  let conversation = try? await RunnerClient(server: server).conversation(summary.id, github: session.token) else {
                runner.toast?("No se pudo abrir la conversación")
                return
            }
            reset()
            preamble = nil
            scope = conversation.scope
            scopeTitle = conversation.scope.ref.flatMap { ref in runner.inbox?.items.first { $0.ref == ref }?.displayTitle }
            conversationId = conversation.id
            turns = conversation.thread.map { message in
                ChatTurn(role: message.role == "user" ? .user : .assistant, text: message.content,
                         proposals: message.proposals, tasks: message.tasks)
            }
        }
    }

    // MARK: preguntar

    func send() {
        let question = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, !streaming else { return }
        input = ""
        // El hilo que se manda: las preguntas y las respuestas con texto (una nota o un turno vacío no van).
        var thread = turns.filter { $0.role != .note && !$0.text.isEmpty }
            .map { (role: $0.role == .user ? "user" : "assistant", content: $0.text) }
            + [(role: "user", content: question)]
        if let preamble { thread[0].content = preamble + thread[0].content }
        turns.append(ChatTurn(role: .user, text: question))
        turns.append(ChatTurn(role: .assistant, text: "", activity: "Pensando…", streaming: true))
        let replyId = turns[turns.count - 1].id
        streaming = true
        let server = runner.selected, scope = scope, conversation = conversationId

        stream = Task { @MainActor in
            let session = await runner.validSession()
            do {
                try await RunnerClient(server: server).ask(scope: scope, messages: thread, conversationId: conversation,
                                                           github: session?.token) { event in
                    DispatchQueue.main.async { self.apply(event, to: replyId) }
                }
            } catch is CancellationError {
            } catch {
                if !Task.isCancelled { apply(AssistantEvent(type: "error", delta: nil, name: nil, summary: nil, proposal: nil, items: nil,
                                                            id: nil, text: nil, message: error.localizedDescription), to: replyId) }
            }
            finish(replyId)
            if session == nil, turns.count <= 2 {
                turns.append(ChatTurn(role: .note, text: "Sin login de GitHub la conversación no se guarda."))
            }
        }
    }

    /// Corta la respuesta: lo que ya llegó se queda.
    func stop() {
        stream?.cancel()
        if let last = turns.last, last.streaming { finish(last.id) }
    }

    private func apply(_ event: AssistantEvent, to id: UUID) {
        guard let i = turns.firstIndex(where: { $0.id == id }) else { return }
        switch event.type {
        case "text": turns[i].text += event.delta ?? ""; turns[i].activity = nil
        case "tool": turns[i].activity = event.summary ?? event.name
        case "proposal": if let p = event.proposal { turns[i].proposals.append(p) }
        case "tasks": turns[i].tasks = event.items ?? []
        case "conversation": conversationId = event.id; loadHistory()
        case "done": if turns[i].text.isEmpty, let text = event.text { turns[i].text = text }
        case "error": turns.append(ChatTurn(role: .note, text: event.message ?? "El asistente falló"))
        default: break
        }
    }

    private func finish(_ id: UUID) {
        streaming = false
        stream = nil
        guard let i = turns.firstIndex(where: { $0.id == id }) else { return }
        turns[i].streaming = false
        turns[i].activity = nil
        // Un turno sin nada (cortado antes de tiempo o fallido) no queda.
        if turns[i].text.isEmpty, turns[i].proposals.isEmpty, turns[i].tasks.isEmpty { turns.remove(at: i) }
        // En «¿Por qué?» el asistente puede haber ajustado la mejora o agregado otra: la bandeja se relee.
        if preamble != nil { runner.refresh() }
    }

    // MARK: propuestas

    /// Lo propuesto lo ejecuta la persona, con su login: se confirma siempre.
    func run(_ proposal: AssistantProposal) {
        guard proposalState[proposal.id] == nil || proposalState[proposal.id]?.hasPrefix("✗") == true else { return }
        let detail = proposal.isIssue
            ? "Abre «\(proposal.title ?? "")» en \(proposal.repo ?? "")."
            : "\(proposal.label) en \(proposal.ref ?? "")."
        runner.confirm?(ConfirmRequest(title: "¿\(proposal.label)?", detail: "\(detail)\n\n\(proposal.reason)",
                                       confirmLabel: proposal.isIssue ? "Abrir issue" : "Ejecutar") { [weak self] in
            self?.execute(proposal)
        })
    }

    private func execute(_ proposal: AssistantProposal) {
        let server = runner.selected
        Task { @MainActor in
            guard let session = await runner.validSession() else {
                runner.toast?("Inicia sesión con GitHub para ejecutarlo")
                return runner.beginLogin()
            }
            proposalState[proposal.id] = "…"
            let client = RunnerClient(server: server)
            if proposal.isIssue {
                let result = await client.createIssue(proposal, github: session.token)
                proposalState[proposal.id] = result.ok ? "✓ \(result.message)" : "✗ \(result.message)"
                if result.ok, let url = result.url.flatMap(URL.init(string:)) { NSWorkspace.shared.open(url) }
            } else if let ref = proposal.ref, let action = proposal.action {
                let result = (try? await client.act(ref: ref, action: action, comment: proposal.comment, github: session.token))
                    ?? TaskActionResult(ok: false, message: "No responde \(server.name)")
                proposalState[proposal.id] = result.ok ? "✓ \(result.message)" : "✗ \(result.message)"
                runner.refresh()
            }
        }
    }
}

extension AssistantModel {
    /// Una conversación de ejemplo para las capturas: no llama a ningún server.
    static func fixture(runner: RunnerModel) -> AssistantModel {
        let model = AssistantModel(runner: runner)
        model.available = true
        model.scope = .task(ref: "la-haus/subscriptions#4301")
        model.scopeTitle = "Migrar tabla de citas"
        model.turns = [
            ChatTurn(role: .user, text: "¿Por qué falló y qué hago?"),
            ChatTurn(role: .assistant, text: """
            La última corrida de **build** falló por un *timeout* del provider a los 14 min, no por el código: el agente \
            había terminado la migración y estaba corriendo los tests.

            - El PR todavía no existe.
            - No hay cambios pedidos en el issue.

            Lo más simple es **reintentar**: retoma desde Build con el mismo contexto.
            """, proposals: [AssistantProposal(id: "p1", kind: nil, label: "Reintentar", reason: "El fallo fue del provider, no del agente.",
                                               ref: "la-haus/subscriptions#4301", action: "retry", comment: nil, repo: nil, title: nil,
                                               body: nil, labels: nil)]),
        ]
        return model
    }

    /// El chat de «¿Por qué?» de las capturas.
    static func fixture(runner: RunnerModel, improvement: Improvement) -> AssistantModel {
        let model = AssistantModel(runner: runner)
        model.available = true
        model.discuss(improvement)
        model.turns = [
            ChatTurn(role: .user, text: "¿Por qué propusiste esto?"),
            ChatTurn(role: .assistant, text: """
            En la ejecución de **build** el implementer probó tres comandos antes de dar con el de integración:

            - `make test` corrió sólo los unitarios y pasó.
            - `uv run pytest tests/integration` falló porque faltaba `CRM_STUB=1`.
            - Lo encontró leyendo el workflow de CI, 9 min después.

            Ni `AGENTS.md` ni el README lo dicen: por eso la mejora va a **docs** del repo.
            """),
        ]
        return model
    }
}
