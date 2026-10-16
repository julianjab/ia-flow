import AppKit
import Foundation

// La ejecución que se está mirando en la pantalla «En vivo»: la tarea, sus ejecuciones y los pasos de la elegida.
// Se relee cada 3 s mientras corre (main.swift); al terminar se lee una vez más y queda quieta.

final class RunWatch: ObservableObject {
    let ref: String
    let server: RunnerServer
    @Published private(set) var item: InboxItem
    /// De la más nueva a la más vieja.
    @Published private(set) var executions: [ExecutionSummary] = []
    /// La que se mira; nil = la última.
    @Published private(set) var executionId: String?
    @Published private(set) var steps: [RunStep] = []
    @Published private(set) var error: String?
    @Published private(set) var loaded = false
    /// Las llamadas al modelo (una por turno) se ven sólo si se piden: llenan la lista sin decir mucho.
    @Published var showModel = false
    /// Seguir el final de la lista cuando llegan pasos nuevos.
    @Published var follow = true
    @Published var expanded: Set<String> = []
    private var loading = false
    private let isFixture: Bool

    init(item: InboxItem, server: RunnerServer, isFixture: Bool = false) {
        ref = item.ref
        self.item = item
        self.server = server
        self.isFixture = isFixture
    }

    var execution: ExecutionSummary? { executions.first { $0.id == executionId } ?? executions.first }
    var running: Bool { execution?.status == "running" }
    /// El agente cuya traza se mira cuando corrió más de uno; nil = todos.
    @Published var agentFilter: String?

    /// Los agentes por los que se puede filtrar: los de la ejecución si corrió más de uno, o los que aparecen en la
    /// traza (una ejecución cerrada que no es la última no trae `agents`). Vacío con uno solo.
    var agents: [AgentEntry] {
        if let agents = execution?.parallelAgents { return agents.map { AgentEntry(id: $0.agent_id, agent: $0) } }
        var seen: [String] = []
        for case let agent? in steps.map(\.agent) where !seen.contains(where: { agentName($0) == agentName(agent) }) { seen.append(agent) }
        return seen.count > 1 ? seen.map { AgentEntry(id: $0) } : []
    }

    /// Lo del agente elegido, más lo que es de la ejecución (el pipeline, el workspace: sin agente).
    private var agentSteps: [RunStep] {
        guard let filter = agentFilter else { return steps }
        return steps.filter { $0.agent.map { agentName($0) == agentName(filter) } ?? true }
    }

    var visibleSteps: [RunStep] { showModel ? agentSteps : agentSteps.filter { $0.kind != .model } }

    /// Lo que está haciendo ahora: el último paso en curso (una tool, el agente) del agente elegido.
    var current: RunStep? {
        agentSteps.last { $0.state == .running && $0.kind == .tool } ?? agentSteps.last { $0.state == .running }
    }

    func select(_ id: String) {
        guard id != execution?.id else { return }
        executionId = id
        agentFilter = nil
        steps = []
        loaded = false
        expanded = []
        follow = true
        poll()
    }

    func toggle(_ id: String) {
        if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
    }

    /// Relee la traza. Una ejecución que ya terminó (y ya se leyó) no se vuelve a pedir.
    func poll() {
        guard !isFixture, !loading, !(loaded && !running && error == nil) else { return }
        loading = true
        let wanted = executionId
        Task { @MainActor in
            defer { loading = false }
            do {
                let detail = try await RunnerClient(server: server).run(ref: ref, execution: wanted)
                guard wanted == executionId else { return }
                apply(detail)
            } catch let e as RunnerError {
                error = e.message
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    /// Fuerza una relectura (el botón): sirve también con una ejecución terminada.
    func reload() {
        loaded = false
        poll()
    }

    private func apply(_ detail: RunDetail) {
        item = detail.item
        executions = detail.executions
        let isRunning = (detail.executions.first { $0.id == executionId } ?? detail.executions.first)?.status == "running"
        let next = RunTrace.steps(detail.trace, running: isRunning)
        if next != steps { steps = next }
        error = nil
        loaded = true
    }

    /// La traza como texto, para pegarla en un issue o un chat.
    func copy() {
        let text = visibleSteps.map { step in
            var line = "\(step.time) \(step.title)"
            if let summary = step.tool.flatMap({ RunTrace.summary(tool: $0, input: step.input) }) ?? step.subtitle { line += " — \(summary)" }
            if let ms = step.durationMs { line += " (\(RunTrace.duration(ms)))" }
            return line
        }.joined(separator: "\n")
        NSPasteboard.general.clearContents()
        let agent = agentFilter.map { " · \(agentName($0))" } ?? ""
        NSPasteboard.general.setString("\(ref) · \(execution?.pipeline_id ?? "")\(agent)\n\(text)", forType: .string)
    }
}

extension RunWatch {
    /// Una ejecución de ejemplo para las capturas: no llama a ningún server.
    static func fixture(item: InboxItem, server: RunnerServer) -> RunWatch {
        let watch = RunWatch(item: item, server: server, isFixture: true)
        watch.loaded = true
        if let review = item.execution, review.parallelAgents != nil {
            watch.executions = [review,
                                ExecutionSummary(id: "e1", pipeline_id: "build", status: "done", started_at: "2026-10-15T09:00:00Z",
                                                 agent_id: "aiflow-implementer")]
            watch.steps = reviewSteps
            return watch
        }
        let started = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-12 * 60))
        watch.executions = [
            ExecutionSummary(id: "e2", pipeline_id: "build", status: "running", started_at: started, agent_id: "aiflow-implementer",
                             usage: ExecutionUsage(input_tokens: 16, output_tokens: 2998, cache_read_tokens: 416_330)),
            ExecutionSummary(id: "e1", pipeline_id: "refine", status: "done", started_at: "2026-10-15T09:00:00Z", agent_id: "aiflow-refiner"),
        ]
        watch.steps = [
            step("1", .stage, .running, "Pipeline build", "12:00:01"),
            step("2", .stage, .running, "Agente aiflow-implementer", "12:00:01"),
            step("3", .note, .warn, "[workspace warn] la branch local tiene commits que origin no tiene; no se sincroniza", "12:00:03"),
            step("4", .prompt, .info, "Prompt del agente", "12:00:04", subtitle: "Por qué estás corriendo", result: "## Por qué estás corriendo…"),
            step("5", .tool, .ok, "Read", "12:00:20", input: #"{"file_path":"/w/app/profile/ProfileScreen.vue"}"#, ms: 40, tool: "Read"),
            step("6", .tool, .ok, "Bash", "12:01:02", input: #"{"command":"yarn lint:js components/profile","description":"Lint del componente"}"#,
                 result: #"{"stdout":"✨ Done in 4.2s","stderr":""}"#, ms: 4200, tool: "Bash"),
            step("7", .tool, .failed, "Bash", "12:03:40", input: #"{"command":"yarn test:run profile","description":"Tests del perfil"}"#,
                 result: #"{"stdout":"FAIL ProfileScreen.spec.ts\n  ✕ muestra el estado vacío","stderr":""}"#, ms: 31_000, tool: "Bash"),
            step("8", .tool, .ok, "Edit", "12:05:12", input: #"{"file_path":"/w/app/profile/ProfileScreen.vue"}"#, ms: 30, tool: "Edit"),
            step("9", .tool, .running, "Bash", "12:06:01", input: #"{"command":"yarn test:run profile","description":"Corre de nuevo los tests"}"#,
                 tool: "Bash"),
        ]
        return watch
    }

    private static func step(_ id: String, _ kind: RunStep.Kind, _ state: RunStep.State, _ title: String, _ time: String,
                             subtitle: String? = nil, input: String? = nil, result: String? = nil, ms: Double? = nil,
                             tool: String? = nil, agent: String? = nil) -> RunStep {
        RunStep(id: id, kind: kind, state: state, title: title, subtitle: subtitle, input: input, result: result, time: time,
                durationMs: ms, tool: tool, agent: agent)
    }

    /// Un review con dos agentes en paralelo: el reviewer ya terminó, el e2e sigue.
    private static var reviewSteps: [RunStep] {
        let reviewer = "aiflow-reviewer", e2e = "aiflow-e2e-visual-qa"
        return [
            step("r1", .stage, .running, "Pipeline review", "12:00:01"),
            step("r2", .stage, .ok, "Agente aiflow-reviewer", "12:00:02", ms: 340_000, agent: reviewer),
            step("r3", .stage, .running, "Agente aiflow-e2e-visual-qa", "12:00:02", agent: e2e),
            step("r4", .tool, .ok, "github · get_pull_request_diff", "12:00:15", input: #"{"owner":"la-haus","repo":"lh-seller-v2-frontend","pull_number":918}"#,
                 ms: 900, tool: "mcp__github__get_pull_request_diff", agent: reviewer),
            step("r5", .tool, .ok, "Bash", "12:00:40", input: #"{"command":"lhtb dev stack up --repo lh-seller-v2-frontend","description":"Levanta el stack local"}"#,
                 ms: 95_000, tool: "Bash", agent: e2e),
            step("r6", .tool, .ok, "Read", "12:01:10", input: #"{"file_path":"/w/app/profile/ProfileScreen.vue"}"#, ms: 35, tool: "Read", agent: reviewer),
            step("r7", .tool, .ok, "github · create_pull_request_review", "12:05:40",
                 input: #"{"owner":"la-haus","repo":"lh-seller-v2-frontend","pull_number":918,"event":"APPROVE"}"#, ms: 1200,
                 tool: "mcp__github__create_pull_request_review", agent: reviewer),
            step("r8", .tool, .ok, "playwright · browser_navigate", "12:06:02", input: #"{"url":"http://localhost:3000/profile"}"#, ms: 2400,
                 tool: "mcp__playwright__browser_navigate", agent: e2e),
            step("r9", .tool, .running, "playwright · browser_take_screenshot", "12:07:12", input: #"{"filename":"perfil-vacio.png"}"#,
                 tool: "mcp__playwright__browser_take_screenshot", agent: e2e),
        ]
    }
}
